import { logger } from './logger.js';
import { loadState } from './state.js';
import { runTarget } from './runner.js';

let groupSeq = 0;

/**
 * Global serial queue with per-source debouncing and job coalescing.
 *
 * - Reflog events for a source repo are debounced (`debounceMs`); the last
 *   event in the window wins.
 * - When the window closes, one job per target of that source is queued, all
 *   tagged with a shared run-group id.
 * - Jobs run strictly one at a time across the whole system.
 * - If a not-yet-started job for the same target is already queued, the new
 *   trigger is merged into it instead of adding a second job (unless
 *   `coalesce` is false). `{pkgs}` already covers every source of a target, so
 *   a second pass would be a no-op.
 * - When every job of a group has finished, `onGroupDone` fires once.
 */
export class UpdateQueue {
  /**
   * @param {ReturnType<import('./config.js').resolveConfig>} config
   * @param {object} [opts]
   * @param {(group: { title: string, tally: object }) => void} [opts.onGroupDone]
   * @param {boolean} [opts.coalesce=true]
   * @param {typeof runTarget} [opts.runner]  injectable for testing
   */
  constructor(config, { onGroupDone, coalesce = true, runner = runTarget } = {}) {
    this.config = config;
    this.onGroupDone = onGroupDone || (() => {});
    this.coalesce = coalesce;
    this.runner = runner;

    /** @type {Map<string, NodeJS.Timeout>} sourcePath -> debounce timer */
    this.timers = new Map();
    /** @type {Map<string, object>} sourcePath -> latest pending event */
    this.pendingEvents = new Map();
    /** @type {Array<object>} ready jobs, processed front to back */
    this.ready = [];
    /** @type {Map<number, { title:string, remaining:number, tally:object }>} */
    this.groups = new Map();
    /** @type {Set<string>} target paths with an in-flight job */
    this.runningTargets = new Set();
    this.processing = false;
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
    const sourcePath = sourceRepo.path;

    const state = loadState();
    const prev = state.repos[sourcePath];
    if (event.sha && prev && prev.lastProcessedSha === event.sha) {
      logger.debug(`[${sourceRepo.name}] sha ${event.sha.slice(0, 7)} zaten işlendi, atlanıyor`);
      return;
    }

    this.pendingEvents.set(sourcePath, { sourceRepo, event });
    if (this.timers.has(sourcePath)) clearTimeout(this.timers.get(sourcePath));

    const debounceMs = this.config.defaults.debounceMs ?? 3000;
    logger.info(
      `[${sourceRepo.name}] olay: ${event.trigger} ${(event.sha || '').slice(0, 7)} ` +
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

    const groupId = ++groupSeq;
    const group = {
      title: `updeps: ${sourceRepo.name}`,
      remaining: 0,
      tally: { committed: 0, unchanged: 0, failed: 0, skipped: 0 }
    };
    this.groups.set(groupId, group);

    for (const target of sourceRepo.packages) {
      const source = {
        name: sourceRepo.name,
        path: sourceRepo.path,
        branch: event.branch,
        sha: event.sha,
        trigger: event.trigger
      };

      const existing = this.coalesce
        ? this.ready.find((j) => j.targetPath === target.path)
        : undefined;

      if (existing) {
        existing.sources.set(source.path, source);
        existing.groupIds.add(groupId);
        group.remaining++;
        logger.debug(`[${target.name}] bekleyen işe birleştirildi (kaynak: ${sourceRepo.name})`);
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
    if (this.processing) return;
    const job = this.ready.find((j) => !this.runningTargets.has(j.targetPath));
    if (!job) return;

    this.ready.splice(this.ready.indexOf(job), 1);
    this.processing = true;
    this.runningTargets.add(job.targetPath);
    this._process(job).finally(() => {
      this.processing = false;
      this.runningTargets.delete(job.targetPath);
      this._drain();
    });
  }

  /** @param {object} job */
  async _process(job) {
    const sources = [...job.sources.values()];
    const primary = sources[sources.length - 1];
    const trigger = {
      trigger: primary.trigger,
      branch: primary.branch,
      sha: primary.sha,
      sourceName: primary.name,
      sourcePath: primary.path
    };

    let result;
    try {
      result = await this.runner({ config: this.config, target: job.target, trigger });
    } catch (err) {
      logger.error(`[${job.target.name}] kuyruk hatası: ${err.message}`);
      result = { status: 'failed', target: job.target.name, message: err.message };
    }

    for (const groupId of job.groupIds) {
      const group = this.groups.get(groupId);
      if (!group) continue;
      group.tally[result.status]++;
      group.remaining--;
      if (group.remaining <= 0) this._settleGroup(groupId);
    }
  }

  /** @param {number} groupId */
  _settleGroup(groupId) {
    const group = this.groups.get(groupId);
    if (!group) return;
    this.groups.delete(groupId);
    try {
      this.onGroupDone({ title: group.title, tally: group.tally });
    } catch (err) {
      logger.error(`onGroupDone hatası: ${err.message}`);
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
