import path from 'node:path';
import { acquireLock } from './lock.js';
import { logger } from './logger.js';
import { runShell, git, gitOrThrow } from './exec.js';
import { interpolateCommand, interpolateMessage } from './template.js';
import { derivePackageNames } from './graph.js';
import { createPathMatcher } from './glob.js';
import {
  checkPreconditions,
  statusSnapshot,
  diffSnapshots,
  selectiveCommit,
  safeRollback,
  activeBranch,
  hashPaths,
  squashableChain,
  squashOnto
} from './gitops.js';
import { loadState, updateState } from './state.js';
import { appendEvent } from './journal.js';
import { redact } from './redact.js';
import { sendNotification, refreshSwiftBar } from './notify.js';

/**
 * @typedef {object} TriggerContext
 * @property {'push'|'fetch'|'commit'|'merge'|'manual'} trigger
 * @property {string} [branch]      branch on the source repo
 * @property {string} [sha]         full sha of the triggering commit
 * @property {string} sourceName
 * @property {string} sourcePath
 */

/**
 * @typedef {object} TargetResult
 * @property {'committed'|'unchanged'|'failed'|'skipped'} status
 * @property {string} target
 * @property {string} message
 * @property {string[]} [warnings]  e.g. changed files left out of the commit
 */

let groupSeq = 0;

/**
 * Generates a run-group id (shared by every target of one trigger).
 * @param {string} [prefix]
 * @returns {string}
 */
export function newGroupId(prefix = 'g') {
  return `${prefix}${Date.now().toString(36)}${(++groupSeq).toString(36)}`;
}

function errId(source, target) {
  return `${source}->${target}`;
}

/**
 * Why a target rejects a trigger, or null if it accepts it. `manual` always
 * accepts. Shared by `runTarget` (its own safety net) and the queue (which
 * pre-filters before a target ever gets coalesced or queued).
 * @param {object} target
 * @param {{ trigger:string, branch?:string }} trigger
 * @returns {string|null}
 */
export function rejectReason(target, trigger) {
  if (trigger.trigger === 'manual') return null;
  if (!target.triggers.includes(trigger.trigger)) {
    return `trigger '${trigger.trigger}' is disabled for this target`;
  }
  if (target.branches.length > 0 && trigger.branch && !target.branches.includes(trigger.branch)) {
    return `branch '${trigger.branch}' is not in this target's branch list`;
  }
  return null;
}

/**
 * @param {object} target
 * @param {{ trigger:string, branch?:string }} trigger
 * @returns {boolean}
 */
export function targetAccepts(target, trigger) {
  return rejectReason(target, trigger) === null;
}

/**
 * Journals a target outcome, updates openFailures, and returns a TargetResult.
 * Standalone so the queue can record a pre-filtered rejection without going
 * through the lock/command pipeline in `runTarget`.
 * @param {object} params
 * @param {object} params.target
 * @param {TriggerContext} params.trigger
 * @param {string} params.group
 * @param {TargetResult['status']} params.status
 * @param {string} params.rawMessage
 * @param {object} [params.extra]
 * @param {number} [params.startedAt]
 * @returns {TargetResult}
 */
export function recordTargetResult({ target, trigger, group, status, rawMessage, extra = {}, startedAt = Date.now() }) {
  const label = target.name;
  const source = trigger.sourceName;
  const id = errId(source, label);
  const message = redact(rawMessage);
  if (extra.errorTail) extra.errorTail = redact(extra.errorTail);
  if (extra.commands) extra.commands = extra.commands.map(redact);
  if (extra.warnings) extra.warnings = extra.warnings.map(redact);

  appendEvent({
    kind: 'target',
    group,
    source,
    sourceSha: (trigger.sha || '').slice(0, 12),
    trigger: trigger.trigger,
    target: label,
    targetPath: target.path,
    status,
    durationMs: Date.now() - startedAt,
    message,
    ...extra
  });

  updateState((state) => {
    if (status === 'failed') {
      const existing = state.openFailures.find((f) => f.id === id);
      if (existing) {
        existing.message = message;
        existing.errorTail = extra.errorTail || '';
        existing.lastSeen = Date.now();
        existing.count += 1;
        existing.group = group;
      } else {
        state.openFailures.unshift({
          id,
          source,
          target: label,
          targetPath: target.path,
          message,
          errorTail: extra.errorTail || '',
          firstSeen: Date.now(),
          lastSeen: Date.now(),
          count: 1,
          group
        });
      }
    } else if (status === 'committed' || status === 'unchanged') {
      // a clean run resolves any standing failure for this pair
      state.openFailures = state.openFailures.filter((f) => f.id !== id);
    }
    return state;
  });

  if (status === 'failed') logger.error(`[${label}] ${message}`);
  return { status, target: label, message, ...(extra.warnings?.length ? { warnings: extra.warnings } : {}) };
}

/**
 * Warning for changed paths that are outside `commitPaths` and were left
 * untouched (neither committed nor reverted). Also logged.
 * @param {string} label
 * @param {string[]} otherFiles
 * @returns {string[]}  zero or one warning
 */
function otherFilesWarning(label, otherFiles) {
  if (otherFiles.length === 0) return [];
  const msg = `files changed outside commitPaths were left untouched: ${otherFiles.join(', ')}`;
  logger.warn(`[${label}] ${msg}`);
  return [msg];
}

const MAX_RECORDED_COMMITS = 50;

/** Sources behind one update commit, as `{bumps}` lists them. */
function currentSources(vars) {
  return vars.sources && vars.sources.length ? vars.sources : [{ name: vars.pkg, sha: vars.sha }];
}

/**
 * Folds the unpushed commits updeps made earlier in this repo into the commit
 * that was just created (HEAD), so repeated updates leave one commit instead
 * of one per update. Only commits recorded in `state.autoCommits` and sitting
 * directly below HEAD are folded (see `squashableChain` for the rules); the
 * result has the same tree as HEAD, so file content is unaffected. Never
 * throws: any problem leaves the just-made commit as it is.
 * @param {object} target
 * @param {object} vars  template variables of this run
 * @returns {{ sha: string, message: string, sources: Array<{name:string, sha:string}>, replaced: string[] }|null}
 */
function foldPreviousCommits(target, vars) {
  try {
    const cwd = target.path;
    const branch = git(['symbolic-ref', '--short', '-q', 'HEAD'], cwd, '');
    const newSha = git(['rev-parse', 'HEAD'], cwd, '');
    const parent = git(['rev-parse', '--verify', '-q', 'HEAD^'], cwd, '');
    if (!branch || !newSha || !parent) return null;

    const chain = squashableChain(cwd, branch, parent, loadState().autoCommits[cwd] || []);
    if (!chain) return null;

    // oldest first; a source that bumped more than once keeps its latest sha
    const merged = new Map();
    for (const commit of [...chain.commits].reverse()) {
      for (const s of commit.sources || []) merged.set(s.name, s.sha);
    }
    for (const s of currentSources(vars)) merged.set(s.name, s.sha);
    const sources = [...merged].map(([name, sha]) => ({ name, sha }));

    const message = interpolateMessage(target.commitMessage, { ...vars, sources });
    const sha = squashOnto(cwd, { branch, base: chain.base, newSha, message });
    if (!sha) return null;
    return { sha, message, sources, replaced: [...chain.commits.map((c) => c.sha), newSha] };
  } catch (err) {
    logger.warn(`[${target.name}] could not squash earlier commits, left them as separate commits: ${err.message}`);
    return null;
  }
}

/**
 * Remembers a commit updeps made so a later update may fold it.
 * @param {string} targetPath
 * @param {{ sha: string, branch: string, sources: object[] }} entry
 * @param {string[]} [replaced]  shas that no longer exist (squashed away)
 */
function recordAutoCommit(targetPath, entry, replaced = []) {
  updateState((state) => {
    const gone = new Set(replaced);
    const prior = (state.autoCommits[targetPath] || []).filter((e) => e.sha !== entry.sha && !gone.has(e.sha));
    state.autoCommits[targetPath] = [entry, ...prior].slice(0, MAX_RECORDED_COMMITS);
    return state;
  });
}

/**
 * Runs the update pipeline for a single target repo.
 * @param {object} params
 * @param {ReturnType<import('./config.js').resolveConfig>} params.config
 * @param {object} params.target      resolved package object
 * @param {TriggerContext} params.trigger
 * @param {string} [params.group]     run-group id for journal correlation
 * @param {string[]} [params.extraGroups]  other run-groups a coalesced job also belongs to
 * @param {boolean} [params.dryRun=false]
 * @param {boolean} [params.echo=false]
 * @param {AbortSignal} [params.signal]  aborts an in-flight command/lock-wait (daemon shutdown)
 * @returns {Promise<TargetResult>}
 */
export async function runTarget({
  config,
  target,
  trigger,
  group,
  extraGroups = [],
  dryRun = false,
  echo = false,
  signal
}) {
  const label = target.name;
  const groupId = group || newGroupId();
  const startedAt = Date.now();

  /** Journals the outcome, updates openFailures, and returns the result. */
  const emit = (status, rawMessage, extra = {}) =>
    recordTargetResult({
      target,
      trigger,
      group: groupId,
      status,
      rawMessage,
      startedAt,
      extra: extraGroups.length ? { ...extra, groups: [groupId, ...extraGroups] } : extra
    });

  const reason = rejectReason(target, trigger);
  if (reason) return emit('skipped', reason);

  if (signal?.aborted) return emit('failed', 'daemon shut down, aborted before start');

  let lock;
  try {
    lock = await acquireLock(target.path, {
      staleLockSec: target.staleLockSec,
      waitTimeoutSec: target.waitTimeoutSec,
      signal
    });
  } catch (err) {
    return emit('failed', err.message);
  }

  const source = trigger.sourceName;

  updateState((state) => {
    state.activeRun = {
      group: groupId,
      source,
      target: label,
      targetPath: target.path,
      startedAt,
      dryRun
    };
    return state;
  });
  refreshSwiftBar();

  try {
    const pre = checkPreconditions(target.path);
    if (!pre.ok) {
      logger.warn(`[${label}] ${pre.reason}`);
      return emit('skipped', pre.reason);
    }

    const before = statusSnapshot(target.path);
    if (target.dirtyPolicy === 'skip' && before.size > 0) {
      return emit('skipped', 'dirty working tree (dirtyPolicy: skip)');
    }

    // Only files matching `commitPaths` (lockfiles, manifests) are treated as
    // the update's output. Anything else that changes while the commands run
    // may come from another process (an editor, a build watcher) and is
    // neither committed nor reverted — only reported.
    const isCommitPath = createPathMatcher(target.commitPaths);

    // Content hashes of commitPaths files that were already dirty before the
    // run. Their `git status` code won't change even if the command edits
    // them further, so `diffSnapshots` alone would miss that update — hash
    // them up front to catch it (see `dirtyTouched` below).
    const dirtyTrackedBefore = [...before.keys()].filter((p) => before.get(p)[0] !== '?' && isCommitPath(p));
    const dirtyHashesBefore = dirtyTrackedBefore.length ? hashPaths(target.path, dirtyTrackedBefore) : null;

    const pkgList = derivePackageNames(config, target.path);
    const vars = {
      pkg: source,
      pkgList: pkgList.length ? pkgList : [source],
      sha: trigger.sha || '',
      sources: trigger.sources && trigger.sources.length ? trigger.sources : undefined,
      sourcePath: trigger.sourcePath || '',
      sourceBranch: trigger.branch || '',
      targetPath: target.path,
      targetBranch: activeBranch(target.path)
    };

    logger.info(`[${label}] starting update (source: ${source})`);

    const ranCommands = [];
    for (const rawCmd of target.commands) {
      const cmd = interpolateCommand(rawCmd, vars);
      ranCommands.push(cmd);
      logger.info(`[${label}] $ ${cmd}`);
      const result = await runShell(cmd, {
        cwd: target.path,
        timeoutMs: target.commandTimeout * 1000,
        env: { CI: '1' },
        signal
      });
      if (result.timedOut || result.aborted || result.code !== 0) {
        const why = result.aborted
          ? 'daemon shut down, rolled back'
          : result.timedOut
            ? `timed out (${target.commandTimeout}s)`
            : `exit code ${result.code}`;
        const tail = (result.stderr || result.stdout || '').trim().split('\n').slice(-8).join('\n');
        logger.error(`[${label}] command failed: ${why}\n${tail}`);
        const { otherFiles } = safeRollback(target.path, before, statusSnapshot(target.path), isCommitPath);
        const warnings = otherFilesWarning(label, otherFiles);
        return emit('failed', `command failed (${cmd}): ${why}`, {
          commands: ranCommands,
          errorTail: tail,
          ...(warnings.length ? { otherFiles, warnings } : {})
        });
      }
    }

    const after = statusSnapshot(target.path);
    const { tracked, untracked } = diffSnapshots(before, after);
    const changedAll = [...tracked, ...untracked];
    const changed = changedAll.filter(isCommitPath);
    const otherFiles = changedAll.filter((p) => !isCommitPath(p));
    const warnings = otherFilesWarning(label, otherFiles);
    const otherExtra = warnings.length ? { otherFiles, warnings } : {};

    let dirtyTouched = [];
    if (dirtyHashesBefore) {
      const dirtyHashesAfter = hashPaths(target.path, dirtyTrackedBefore);
      dirtyTouched = dirtyTrackedBefore.filter((p) => dirtyHashesAfter.get(p) !== dirtyHashesBefore.get(p));
    }

    if (changed.length === 0) {
      if (dirtyTouched.length > 0) {
        const msg = `update landed in an already-dirty file, not committed: ${dirtyTouched.join(', ')}`;
        logger.warn(`[${label}] ${msg}`);
        return emit('skipped', msg, { commands: ranCommands, dirtyTouched, ...otherExtra });
      }
      logger.info(`[${label}] no changes (up to date)`);
      return emit('unchanged', 'no changes', { commands: ranCommands, ...otherExtra });
    }

    let commitMsg = interpolateMessage(target.commitMessage, vars);

    if (dryRun) {
      const changedTracked = changed.filter((p) => !untracked.includes(p));
      const stat = changedTracked.length ? git(['diff', '--stat', '--', ...changedTracked], target.path, '') : '';
      logger.info(`[${label}] [dry-run] nothing will be committed: ${changed.join(', ')}\n${stat}`);
      safeRollback(target.path, before, after, isCommitPath);
      return emit('committed', `[dry-run] ${commitMsg}`, {
        commands: ranCommands,
        files: changed,
        dryRun: true,
        ...otherExtra
      });
    }

    if (dirtyTouched.length > 0) {
      logger.warn(
        `[${label}] update also touched an already-dirty file, not included in the commit: ${dirtyTouched.join(', ')}`
      );
    }

    let shortSha = selectiveCommit(target.path, changed, commitMsg);
    logger.info(`[${label}] commit ${shortSha}: "${commitMsg}" (${changed.length} files)`);

    // Remember the commit; fold earlier unpushed updeps commits into it if allowed.
    const branch = git(['symbolic-ref', '--short', '-q', 'HEAD'], target.path, '');
    let sources = currentSources(vars);
    let replaced = [];
    const folded = target.squash ? foldPreviousCommits(target, vars) : null;
    if (folded) {
      shortSha = git(['rev-parse', '--short', folded.sha], target.path, folded.sha.slice(0, 7));
      commitMsg = folded.message;
      sources = folded.sources;
      replaced = folded.replaced;
      logger.info(
        `[${label}] squashed ${replaced.length} commits into one → ${shortSha}: "${commitMsg}"`
      );
    }
    if (branch) {
      const headSha = git(['rev-parse', 'HEAD'], target.path, '');
      if (headSha) recordAutoCommit(target.path, { sha: headSha, branch, sources }, replaced);
    }

    if (target.push) {
      logger.info(`[${label}] git push...`);
      try {
        gitOrThrow(['push'], target.path);
        logger.info(`[${label}] push done`);
      } catch (err) {
        return emit('failed', `committed, but push failed: ${err.message}`, {
          commands: ranCommands,
          commitSha: shortSha,
          ...(replaced.length ? { squashed: replaced.map((s) => s.slice(0, 7)) } : {}),
          ...otherExtra
        });
      }
    }

    updateState((state) => {
      // Keyed by target path. Note: a repo that is both a source and a target
      // has ONE entry here; `lastProcessedSha` is reserved for source-side
      // dedup (written by recordGroupDone / the watcher baseline), so the
      // target side uses its own fields and never touches it.
      state.repos[target.path] = {
        ...(state.repos[target.path] || {}),
        lastUpdatedFrom: source,
        lastUpdatedSha: (trigger.sha || '').slice(0, 12),
        lastUpdatedAt: Date.now(),
        lastCommitMessage: commitMsg
      };
      return state;
    });

    return emit('committed', commitMsg, {
      commands: ranCommands,
      commitSha: shortSha,
      files: changed,
      pushed: Boolean(target.push),
      ...(replaced.length ? { squashed: replaced.map((s) => s.slice(0, 7)) } : {}),
      ...(dirtyTouched.length ? { dirtyTouched } : {}),
      ...otherExtra
    });
  } finally {
    lock.release();
    updateState((state) => {
      if (state.activeRun && state.activeRun.group === groupId && state.activeRun.target === label) {
        state.activeRun = null;
      }
      return state;
    });
    refreshSwiftBar();
  }
}

/**
 * Runs updates for every target of a source repo, one at a time.
 * @param {object} params
 * @param {ReturnType<import('./config.js').resolveConfig>} params.config
 * @param {object} params.sourceRepo
 * @param {TriggerContext} params.trigger
 * @param {string} [params.group]
 * @param {boolean} [params.dryRun=false]
 * @param {boolean} [params.echo=false]
 * @param {string|null} [params.targetFilter]
 * @returns {Promise<{ group:string, committed:number, unchanged:number, failed:number, skipped:number, results: TargetResult[] }>}
 */
export async function runSourceRepo({
  config,
  sourceRepo,
  trigger,
  group,
  dryRun = false,
  echo = false,
  targetFilter = null
}) {
  const groupId = group || newGroupId();
  let targets = sourceRepo.packages;
  if (targetFilter) {
    targets = targets.filter(
      (t) => t.name === targetFilter || t.path === targetFilter || path.basename(t.path) === targetFilter
    );
  }

  appendEvent({
    kind: 'group_start',
    group: groupId,
    source: sourceRepo.name,
    trigger: trigger.trigger,
    sha: (trigger.sha || '').slice(0, 12),
    targetCount: targets.length,
    dryRun
  });

  const results = [];
  for (const target of targets) {
    try {
      results.push(await runTarget({ config, target, trigger, group: groupId, dryRun, echo }));
    } catch (err) {
      logger.error(`[${target.name}] unexpected error: ${err.message}`);
      results.push({ status: 'failed', target: target.name, message: err.message });
    }
  }

  const tally = {
    group: groupId,
    committed: results.filter((r) => r.status === 'committed').length,
    unchanged: results.filter((r) => r.status === 'unchanged').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    results
  };

  recordGroupDone({ sourceRepo, trigger, tally });
  return tally;
}

/**
 * Journals a group_done event and updates state.lastRuns.
 * @param {object} params
 * @param {object} params.sourceRepo   { name, path }
 * @param {TriggerContext} params.trigger
 * @param {{ group:string, committed:number, unchanged:number, failed:number, skipped:number }} params.tally
 */
export function recordGroupDone({ sourceRepo, trigger, tally }) {
  appendEvent({
    kind: 'group_done',
    group: tally.group,
    source: sourceRepo.name,
    trigger: trigger.trigger,
    sha: (trigger.sha || '').slice(0, 12),
    committed: tally.committed,
    unchanged: tally.unchanged,
    failed: tally.failed,
    skipped: tally.skipped
  });

  updateState((state) => {
    state.lastRuns = [
      {
        timestamp: Date.now(),
        group: tally.group,
        sourceRepo: sourceRepo.name,
        trigger: trigger.trigger,
        sha: (trigger.sha || '').slice(0, 7),
        committed: tally.committed,
        unchanged: tally.unchanged,
        failed: tally.failed,
        skipped: tally.skipped
      },
      ...state.lastRuns
    ].slice(0, 50);
    if (trigger.sha && sourceRepo.path) {
      state.repos[sourceRepo.path] = {
        ...(state.repos[sourceRepo.path] || {}),
        lastProcessedSha: trigger.sha,
        lastProcessedAt: Date.now()
      };
    }
    return state;
  });

  logger.info(
    `[${sourceRepo.name}] finished: ${tally.committed} committed, ${tally.unchanged} up to date, ` +
      `${tally.failed} failed, ${tally.skipped} skipped`
  );
}

/**
 * Sends the single summary notification for a run group.
 * @param {object} params
 * @param {boolean} params.notifications
 * @param {string} params.title
 * @param {{ committed:number, unchanged:number, failed:number, skipped:number }} params.tally
 */
export function notifyRunGroup({ notifications, title, tally }) {
  const msg =
    `${tally.committed} committed, ${tally.unchanged} up to date, ${tally.failed} failed` +
    (tally.skipped ? `, ${tally.skipped} skipped` : '');
  sendNotification({
    type: tally.failed > 0 ? 'fail' : 'ok',
    title,
    message: msg,
    enabled: notifications
  });
}
