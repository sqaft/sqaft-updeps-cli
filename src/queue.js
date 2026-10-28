import { setTimeout as sleep } from 'node:timers/promises';
import { logger } from './logger.js';
import { loadState, updateState } from './state.js';
import { runTarget, recordGroupDone, recordTargetResult, rejectReason, newGroupId } from './runner.js';
import { appendEvent } from './journal.js';

/**
 * Fields that determine what running a target actually *does*. Two queued
 * jobs for the same target path may only be merged into one run when these
 * match — otherwise a source with e.g. a narrower `branches` list or a
 * different `commands` array would silently inherit another source's
 * resolved target instead of its own.
 * @param {object} target
 * @returns {string}
 */
function execKey(target) {
  return JSON.stringify({
    commands: target.commands,
    commitMessage: target.commitMessage,
    commandTimeout: target.commandTimeout,
    dirtyPolicy: target.dirtyPolicy,
    commitPaths: target.commitPaths,
    push: target.push,
    squash: target.squash,
    staleLockSec: target.staleLockSec,
    waitTimeoutSec: target.waitTimeoutSec
  });
}

/**
 * Global serial queue with per-source debouncing and job coalescing.
 *
 * - Reflog events for a source repo are debounced (`debounceMs`); the last
 *   event in the window wins.
 * - When the window closes, one job per target of that source is queued, all
 *   tagged with a shared run-group id. A target that rejects the trigger
 *   (wrong trigger type / branch not listed) is resolved as `skipped` right
 *   here, before ever touching the queue or a lock.
 * - Jobs run strictly one at a time across the whole system.
 * - If a not-yet-started job for the *same resolved target* (path + execKey)
 *   is already queued, the new trigger is merged into it instead of adding a
 *   second job — but only when the target's own `coalesce` setting (config:
 *   `defaults.coalesce` / `repos[].packages[].coalesce`, default `true`)
 *   allows it. `{pkgs}`/`{bumps}` already cover every source of a target, so
 *   a second pass with the same execution config would be a no-op; a
 *   different execKey never merges regardless of `coalesce`, since running it
 *   would silently apply the wrong source's config.
 * - When every job of a group has finished, `onGroupDone` fires once.
 */
export class UpdateQueue {
  /**
   * @param {ReturnType<import('./config.js').resolveConfig>} config
   * @param {object} [opts]
   * @param {(group: { title: string, tally: object }) => void} [opts.onGroupDone]
   * @param {typeof runTarget} [opts.runner]  injectable for testing
   */
  constructor(config, { onGroupDone, runner = runTarget } = {}) {
    this.config = config;
    this.onGroupDone = onGroupDone || (() => {});
    this.runner = runner;

    /** @type {Map<string, NodeJS.Timeout>} sourcePath -> debounce timer */
    this.timers = new Map();
    /** @type {Map<string, object>} sourcePath -> latest pending event */
    this.pendingEvents = new Map();
    /** @type {Array<object>} ready jobs, processed front to back */
    this.ready = [];
    /** @type {Map<string, { title, remaining, tally, sourceRepo, event }>} */
    this.groups = new Map();
    /** @type {Set<string>} target paths with an in-flight job */
    this.runningTargets = new Set();
    this.processing = false;

    /** True once `shutdown()` has been called: no new jobs are started. */
    this.shuttingDown = false;
    /** @type {AbortController|null} controller for the currently running job, if any */
    this.activeAbortController = null;
    /** @type {Promise<void>|null} the currently running job's promise, if any */
    this.activeProcessPromise = null;
  }

  /** @param {ReturnType<import('./config.js').resolveConfig>} config */
  updateConfig(config) {
    this.config = config;
  }

  /**
   * @param {object} sourceRepo resolved source repo
   * @param {{ trigger:string, branch:string, sha:string }} event
   */
  enqueue(sourceRepo, event) {
    if (this.shuttingDown) return;
    const sourcePath = sourceRepo.path;

    const state = loadState();
    const prev = state.repos[sourcePath];
    if (event.sha && prev && prev.lastProcessedSha === event.sha) {
      logger.debug(`[${sourceRepo.name}] sha ${event.sha.slice(0, 7)} already processed, skipping`);
      return;
    }

    this.pendingEvents.set(sourcePath, { sourceRepo, event });
    if (this.timers.has(sourcePath)) clearTimeout(this.timers.get(sourcePath));

    const debounceMs = this.config.defaults.debounceMs ?? 3000;
    logger.info(
      `[${sourceRepo.name}] event: ${event.trigger} ${(event.sha || '').slice(0, 7)} ` +
        `(${debounceMs}ms debounce)`
    );

    this.timers.set(
      sourcePath,
      setTimeout(() => {
        this.timers.delete(sourcePath);
        this._flush(sourcePath);
      }, debounceMs)
    );
  }

  /** @param {string} sourcePath */
  _flush(sourcePath) {
    const item = this.pendingEvents.get(sourcePath);
    if (!item) return;
    this.pendingEvents.delete(sourcePath);

    const { sourceRepo, event } = item;
    if (sourceRepo.packages.length === 0) return;

    const groupId = newGroupId();
    const group = {
      title: `updeps: ${sourceRepo.name}`,
      remaining: 0,
      tally: { group: groupId, committed: 0, unchanged: 0, failed: 0, skipped: 0 },
      sourceRepo,
      event
    };
    this.groups.set(groupId, group);

    appendEvent({
      kind: 'group_start',
      group: groupId,
      source: sourceRepo.name,
      trigger: event.trigger,
      sha: (event.sha || '').slice(0, 12),
      targetCount: sourceRepo.packages.length
    });

    for (const target of sourceRepo.packages) {
      const triggerCtx = { trigger: event.trigger, branch: event.branch };
      const reason = rejectReason(target, triggerCtx);
      if (reason) {
        group.tally.skipped++;
        recordTargetResult({
          target,
          trigger: { ...triggerCtx, sha: event.sha, sourceName: sourceRepo.name, sourcePath: sourceRepo.path },
          group: groupId,
          status: 'skipped',
          rawMessage: reason
        });
        continue;
      }

      const source = {
        name: sourceRepo.name,
        path: sourceRepo.path,
        branch: event.branch,
        sha: event.sha,
        trigger: event.trigger
      };

      const existing = target.coalesce
        ? this.ready.find((j) => j.targetPath === target.path && execKey(j.target) === execKey(target))
        : undefined;

      if (existing) {
        existing.sources.set(source.path, source);
        existing.groupIds.add(groupId);
        group.remaining++;
        logger.debug(`[${target.name}] merged into pending job (source: ${sourceRepo.name})`);
      } else {
        this.ready.push({
          targetPath: target.path,
          target,
          sources: new Map([[source.path, source]]),
          groupIds: new Set([groupId])
        });
        group.remaining++;
      }
    }

    if (group.remaining === 0) this._settleGroup(groupId);
    this._drain();
  }

  _drain() {
    this._writeQueueDepth();
    if (this.processing || this.shuttingDown) return;
    const job = this.ready.find((j) => !this.runningTargets.has(j.targetPath));
    if (!job) return;

    this.ready.splice(this.ready.indexOf(job), 1);
    this.processing = true;
    this.runningTargets.add(job.targetPath);
    this._writeQueueDepth();
    const controller = new AbortController();
    this.activeAbortController = controller;
    this.activeProcessPromise = this._process(job, controller.signal).finally(() => {
      this.processing = false;
      this.runningTargets.delete(job.targetPath);
      this.activeAbortController = null;
      this.activeProcessPromise = null;
      this._writeQueueDepth();
      this._drain();
    });
  }

  /**
   * Stops accepting new work and waits for the currently running job to
   * finish — aborting it first so it doesn't run forever. Debounced events
   * that hadn't produced a job yet are dropped (their source's reflog tip is
   * unchanged, so the daemon picks them up again on next start — see
   * `ReflogWatcher`'s missed-push catch-up). Jobs that had already been
   * queued but never got a turn are settled as `skipped` (rather than left
   * to dangle with their group never completing) for the same reason.
   * @param {number} [timeoutMs=15000]
   */
  async shutdown(timeoutMs = 15000) {
    this.shuttingDown = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pendingEvents.clear();

    if (this.activeProcessPromise) {
      this.activeAbortController?.abort();
      await Promise.race([
        this.activeProcessPromise,
        sleep(timeoutMs).then(() =>
          logger.warn('Shutdown timed out, exiting without waiting for the active job.')
        )
      ]);
    }

    const stillQueued = this.ready.splice(0, this.ready.length);
    for (const job of stillQueued) {
      const groupId = [...job.groupIds][0];
      const result = recordTargetResult({
        target: job.target,
        trigger: { trigger: 'shutdown', sourceName: [...job.sources.values()][0]?.name || '' },
        group: groupId,
        status: 'skipped',
        rawMessage: 'daemon shut down, not run'
      });
      this._applyResult(job, result);
    }
    this._writeQueueDepth();
  }

  /** @param {object} job @param {{status:string}} result */
  _applyResult(job, result) {
    for (const groupId of job.groupIds) {
      const group = this.groups.get(groupId);
      if (!group) continue;
      group.tally[result.status]++;
      group.remaining--;
      if (group.remaining <= 0) this._settleGroup(groupId);
    }
  }

  _writeQueueDepth() {
    try {
      const jobs = this.ready.map((j) => ({
        target: j.target.name,
        targetPath: j.targetPath,
        sources: [...j.sources.values()].map((s) => s.name)
      }));
      updateState((state) => {
        state.queue = { pending: jobs.length, jobs };
        return state;
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * Re-resolves a queued job's target from the *current* config, trying each
   * of the job's sources in turn. Config can live-reload while a job sits in
   * `ready` (edited while queued, or a target removed); running the stale
   * snapshot captured at enqueue time would apply outdated commands, or run a
   * target that no longer exists in the config at all.
   * @param {object} job
   * @returns {object|null}
   */
  _resolveCurrentTarget(job) {
    for (const source of job.sources.values()) {
      const repo = this.config.repos.find((r) => r.path === source.path);
      const target = repo?.packages.find((p) => p.path === job.targetPath);
      if (target) return target;
    }
    return null;
  }

  /**
   * @param {object} job
   * @param {AbortSignal} [signal]  aborts an in-flight command on shutdown
   */
  async _process(job, signal) {
    const sources = [...job.sources.values()];
    const primary = sources[sources.length - 1];
    const trigger = {
      trigger: primary.trigger,
      branch: primary.branch,
      sha: primary.sha,
      sourceName: primary.name,
      sourcePath: primary.path,
      sources: sources.map((s) => ({ name: s.name, sha: s.sha }))
    };
    const groupIds = [...job.groupIds];
    const primaryGroup = groupIds[groupIds.length - 1];
    const extraGroups = groupIds.filter((g) => g !== primaryGroup);

    const currentTarget = this._resolveCurrentTarget(job);

    let result;
    if (!currentTarget) {
      logger.warn(`[${job.target.name}] target was removed from the config, skipping`);
      result = recordTargetResult({
        target: job.target,
        trigger,
        group: primaryGroup,
        status: 'skipped',
        rawMessage: 'target was removed from the config, not run',
        extra: extraGroups.length ? { groups: [primaryGroup, ...extraGroups] } : {}
      });
    } else {
      try {
        result = await this.runner({
          config: this.config,
          target: currentTarget,
          trigger,
          group: primaryGroup,
          extraGroups,
          signal
        });
      } catch (err) {
        logger.error(`[${job.target.name}] queue error: ${err.message}`);
        result = { status: 'failed', target: job.target.name, message: err.message };
      }
    }

    this._applyResult(job, result);
  }

  /** @param {string} groupId */
  _settleGroup(groupId) {
    const group = this.groups.get(groupId);
    if (!group) return;
    this.groups.delete(groupId);

    try {
      recordGroupDone({
        sourceRepo: group.sourceRepo,
        trigger: {
          trigger: group.event.trigger,
          branch: group.event.branch,
          sha: group.event.sha,
          sourceName: group.sourceRepo.name,
          sourcePath: group.sourceRepo.path
        },
        tally: group.tally
      });
    } catch (err) {
      logger.error(`failed to record group_done: ${err.message}`);
    }

    try {
      this.onGroupDone({ title: group.title, tally: group.tally });
    } catch (err) {
      logger.error(`onGroupDone error: ${err.message}`);
    }
  }

  /** @returns {boolean} */
  get idle() {
    return (
      !this.processing &&
      this.ready.length === 0 &&
      this.timers.size === 0 &&
      this.pendingEvents.size === 0
    );
  }
}
