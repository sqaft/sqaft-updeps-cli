import path from 'node:path';
import { acquireLock } from './lock.js';
import { logger } from './logger.js';
import { runShell, git, gitOrThrow } from './exec.js';
import { interpolateCommand, interpolateMessage } from './template.js';
import { derivePackageNames } from './graph.js';
import {
  checkPreconditions,
  statusSnapshot,
  diffSnapshots,
  selectiveCommit,
  safeRollback,
  activeBranch,
  unpushedCount
} from './gitops.js';
import { updateState } from './state.js';
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
 */

/**
 * Runs the update pipeline for a single target repo.
 * @param {object} params
 * @param {ReturnType<import('./config.js').resolveConfig>} params.config
 * @param {object} params.target      resolved package object
 * @param {TriggerContext} params.trigger
 * @param {boolean} [params.dryRun=false]
 * @param {boolean} [params.echo=false]
 * @returns {Promise<TargetResult>}
 */
export async function runTarget({ config, target, trigger, dryRun = false, echo = false }) {
  const label = target.name;

  if (trigger.trigger !== 'manual') {
    if (!target.triggers.includes(trigger.trigger)) {
      return skip(label, `tetikleyici '${trigger.trigger}' bu hedef için kapalı`);
    }
    if (target.branches.length > 0 && trigger.branch && !target.branches.includes(trigger.branch)) {
      return skip(label, `branch '${trigger.branch}' bu hedef için listede değil`);
    }
  }

  let lock;
  try {
    lock = await acquireLock(target.path, {
      staleLockSec: target.staleLockSec,
      waitTimeoutSec: target.waitTimeoutSec
    });
  } catch (err) {
    return finishError(label, trigger, err.message, echo);
  }

  try {
    const pre = checkPreconditions(target.path);
    if (!pre.ok) {
      logger.warn(`[${label}] ${pre.reason}`);
      return skip(label, pre.reason);
    }

    const before = statusSnapshot(target.path);
    if (target.dirtyPolicy === 'skip' && before.size > 0) {
      return skip(label, 'working tree kirli (dirtyPolicy: skip)');
    }

    const pkgList = derivePackageNames(config, target.path);
    const vars = {
      pkg: trigger.sourceName,
      pkgList: pkgList.length ? pkgList : [trigger.sourceName],
      sha: trigger.sha || '',
      sourcePath: trigger.sourcePath || '',
      sourceBranch: trigger.branch || '',
      targetPath: target.path,
      targetBranch: activeBranch(target.path)
    };

    logger.info(`[${label}] güncelleme başlıyor (kaynak: ${trigger.sourceName})`);

    for (const rawCmd of target.commands) {
      const cmd = interpolateCommand(rawCmd, vars);
      logger.info(`[${label}] $ ${cmd}`);
      const result = await runShell(cmd, {
        cwd: target.path,
        timeoutMs: target.commandTimeout * 1000,
        env: { CI: '1' }
      });
      if (result.timedOut || result.code !== 0) {
        const why = result.timedOut
          ? `zaman aşımı (${target.commandTimeout}s)`
          : `çıkış kodu ${result.code}`;
        const tail = (result.stderr || result.stdout || '').trim().split('\n').slice(-5).join('\n');
        logger.error(`[${label}] komut hatası: ${why}\n${tail}`);
        safeRollback(target.path, before, statusSnapshot(target.path));
        return finishError(label, trigger, `komut hatası (${cmd}): ${why}`, echo);
      }
    }

    const after = statusSnapshot(target.path);
    const { tracked, untracked } = diffSnapshots(before, after);
    const changed = [...tracked, ...untracked];

    if (changed.length === 0) {
      logger.info(`[${label}] değişiklik yok (güncel)`);
      clearError(label, trigger);
      return { status: 'unchanged', target: label, message: 'değişiklik yok' };
    }

    const commitMsg = interpolateMessage(target.commitMessage, vars);

    if (dryRun) {
      const stat = git(['diff', '--stat'], target.path, '');
      logger.info(`[${label}] [dry-run] commit atılmayacak:\n${stat}`);
      safeRollback(target.path, before, after);
      clearError(label, trigger);
      return { status: 'committed', target: label, message: `[dry-run] ${commitMsg}` };
    }

    const shortSha = selectiveCommit(target.path, changed, commitMsg);
    logger.info(`[${label}] commit ${shortSha}: "${commitMsg}" (${changed.length} dosya)`);

    if (target.push) {
      logger.info(`[${label}] git push...`);
      try {
        gitOrThrow(['push'], target.path);
        logger.info(`[${label}] push tamam`);
      } catch (err) {
        logger.error(`[${label}] push başarısız: ${err.message}`);
        return finishError(label, trigger, `commit atıldı ama push başarısız: ${err.message}`, echo);
      }
    }

    updateState((state) => {
      state.repos[target.path] = {
        lastProcessedSha: trigger.sha || '',
        lastProcessedAt: Date.now(),
        pendingPushCount: unpushedCount(target.path),
        lastCommitMessage: commitMsg
      };
      state.errors = (state.errors || []).filter((e) => e.id !== errId(label, trigger));
      return state;
    });

    return { status: 'committed', target: label, message: commitMsg };
  } finally {
    lock.release();
    refreshSwiftBar();
  }
}

/**
 * Runs updates for every target of a source repo, one at a time.
 * @param {object} params
 * @param {ReturnType<import('./config.js').resolveConfig>} params.config
 * @param {object} params.sourceRepo
 * @param {TriggerContext} params.trigger
 * @param {boolean} [params.dryRun=false]
 * @param {boolean} [params.echo=false]
 * @param {string|null} [params.targetFilter]
 * @returns {Promise<{ committed:number, unchanged:number, failed:number, skipped:number, results: TargetResult[] }>}
 */
export async function runSourceRepo({
  config,
  sourceRepo,
  trigger,
  dryRun = false,
  echo = false,
  targetFilter = null
}) {
  let targets = sourceRepo.packages;
  if (targetFilter) {
    targets = targets.filter(
      (t) => t.name === targetFilter || t.path === targetFilter || path.basename(t.path) === targetFilter
    );
  }

  const results = [];
  for (const target of targets) {
    try {
      results.push(await runTarget({ config, target, trigger, dryRun, echo }));
    } catch (err) {
      logger.error(`[${target.name}] beklenmeyen hata: ${err.message}`);
      results.push({ status: 'failed', target: target.name, message: err.message });
    }
  }

  const tally = {
    committed: results.filter((r) => r.status === 'committed').length,
    unchanged: results.filter((r) => r.status === 'unchanged').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    results
  };

  updateState((state) => {
    state.lastRuns = [
      {
        timestamp: Date.now(),
        sourceRepo: sourceRepo.name,
        trigger: trigger.trigger,
        sha: (trigger.sha || '').slice(0, 7),
        committed: tally.committed,
        unchanged: tally.unchanged,
        failed: tally.failed,
        skipped: tally.skipped
      },
      ...(state.lastRuns || [])
    ].slice(0, 50);
    if (trigger.sha) {
      state.repos[sourceRepo.path] = {
        ...(state.repos[sourceRepo.path] || {}),
        lastProcessedSha: trigger.sha,
        lastProcessedAt: Date.now()
      };
    }
    return state;
  });

  logger.info(
    `[${sourceRepo.name}] tamamlandı: ${tally.committed} commit, ${tally.unchanged} güncel, ` +
      `${tally.failed} hata, ${tally.skipped} atlandı`
  );

  return tally;
}

function skip(target, message) {
  logger.info(`[${target}] atlandı: ${message}`);
  return { status: 'skipped', target, message };
}

function errId(label, trigger) {
  return `${trigger.sourceName}->${label}`;
}

function finishError(label, trigger, message, echo) {
  logger.error(`[${label}] ${message}`);
  updateState((state) => {
    state.errors = (state.errors || []).filter((e) => e.id !== errId(label, trigger));
    state.errors.unshift({
      id: errId(label, trigger),
      sourceRepo: trigger.sourceName,
      target: label,
      message,
      timestamp: Date.now()
    });
    state.errors = state.errors.slice(0, 20);
    return state;
  });
  return { status: 'failed', target: label, message };
}

function clearError(label, trigger) {
  updateState((state) => {
    state.errors = (state.errors || []).filter((e) => e.id !== errId(label, trigger));
    return state;
  });
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
    `${tally.committed} commit, ${tally.unchanged} güncel, ${tally.failed} hata` +
    (tally.skipped ? `, ${tally.skipped} atlandı` : '');
  sendNotification({
    type: tally.failed > 0 ? 'fail' : 'ok',
    title,
    message: msg,
    enabled: notifications
  });
}
