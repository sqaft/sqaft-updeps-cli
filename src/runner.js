import fs from 'node:fs';
import path from 'node:path';
import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireLock } from './lock.js';
import { logger } from './logger.js';
import { updateState } from './state.js';
import { sendNotification } from './notify.js';
import { refreshSwiftBar } from './commands/menubar.js';

const execAsync = promisify(exec);

/**
 * Replaces placeholders in command or commit message templates.
 * @param {string} template
 * @param {object} variables
 * @returns {string}
 */
export function interpolateVariables(template, variables) {
  if (!template) return '';

  const map = {
    '{pkg}': variables.pkg || '',
    '{pkgs}': variables.pkgs || variables.pkg || '',
    '{sha}': variables.sha ? variables.sha.slice(0, 7) : '',
    '{bumps}': variables.bumps || `${variables.pkg || ''}@${variables.sha ? variables.sha.slice(0, 7) : ''}`,
    '{sourcePath}': variables.sourcePath || '',
    '{targetPath}': variables.targetPath || variables.repoPath || '',
    '{repoPath}': variables.targetPath || variables.repoPath || '',
    '{sourceBranch}': variables.sourceBranch || '',
    '{targetBranch}': variables.targetBranch || variables.branch || '',
    '{branch}': variables.targetBranch || variables.branch || ''
  };

  let result = template;
  for (const [key, value] of Object.entries(map)) {
    result = result.replaceAll(key, value);
  }
  return result;
}

/**
 * Checks if target directory is an operational git repository.
 * @param {string} targetPath
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkGitPreconditions(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return { ok: false, reason: `Dizin mevcut değil: ${targetPath}` };
  }

  const gitDir = path.join(targetPath, '.git');
  if (!fs.existsSync(gitDir)) {
    return { ok: false, reason: `Git reposu değil: ${targetPath}` };
  }

  // Check if rebase / merge / cherry-pick in progress
  const conflictMarkers = [
    'rebase-merge',
    'rebase-apply',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'BISECT_LOG'
  ];

  for (const marker of conflictMarkers) {
    if (fs.existsSync(path.join(gitDir, marker))) {
      return { ok: false, reason: `Repo işlem ortasında (${marker} mevcut), atlandı: ${targetPath}` };
    }
  }

  // Check working tree clean
  try {
    const status = execSync('git status --porcelain', { cwd: targetPath, encoding: 'utf8' }).trim();
    if (status.length > 0) {
      return { ok: false, reason: `Working tree temiz değil (kaydedilmemiş değişiklikler var), atlandı: ${targetPath}` };
    }
  } catch (err) {
    return { ok: false, reason: `Git durumu sorgulanamadı: ${err.message}` };
  }

  return { ok: true };
}

/**
 * Gets active branch name for target repo.
 * @param {string} targetPath
 * @returns {string}
 */
export function getActiveBranch(targetPath) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: targetPath, encoding: 'utf8' }).trim();
  } catch {
    return 'main';
  }
}

/**
 * Gets number of unpushed commits on current branch.
 * @param {string} targetPath
 * @returns {number}
 */
export function getUnpushedCount(targetPath) {
  try {
    const out = execSync('git rev-list --count @{u}..HEAD', { cwd: targetPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const count = parseInt(out, 10);
    return isNaN(count) ? 0 : count;
  } catch {
    return 0;
  }
}

/**
 * Reverts changes in target repo if command fails.
 * @param {string} targetPath
 */
export function rollbackWorkingTree(targetPath) {
  try {
    execSync('git reset --hard HEAD', { cwd: targetPath, stdio: 'ignore' });
    execSync('git clean -fd', { cwd: targetPath, stdio: 'ignore' });
  } catch (err) {
    logger.warn(`Geri alma başarısız (${targetPath}): ${err.message}`);
  }
}

/**
 * Executes update pipeline for a single target package.
 * @param {object} params
 * @param {object} params.sourceRepo
 * @param {object} params.pkg Target package config
 * @param {object} params.triggerContext
 * @param {boolean} [params.dryRun=false]
 * @param {boolean} [params.echo=false]
 * @returns {Promise<{ status: 'committed'|'unchanged'|'failed'|'skipped', target: string, message: string }>}
 */
export async function runTarget({ sourceRepo, pkg, triggerContext, dryRun = false, echo = false }) {
  const targetLabel = pkg.name || path.basename(pkg.path);
  const targetPath = pkg.path;

  // Filter by trigger type (manual runs always proceed)
  if (triggerContext.trigger && triggerContext.trigger !== 'manual' && pkg.triggers && !pkg.triggers.includes(triggerContext.trigger)) {
    return {
      status: 'skipped',
      target: targetLabel,
      message: `Tetikleyici (${triggerContext.trigger}) bu hedef için aktif değil.`
    };
  }

  // Filter by branch
  if (triggerContext.branch && pkg.branches && pkg.branches.length > 0) {
    if (!pkg.branches.includes(triggerContext.branch)) {
      return {
        status: 'skipped',
        target: targetLabel,
        message: `Branch (${triggerContext.branch}) bu hedef için izinli listede değil.`
      };
    }
  }

  // Pre-checks
  const preCheck = checkGitPreconditions(targetPath);
  if (!preCheck.ok) {
    logger.warn(`[${targetLabel}] ${preCheck.reason}`, { echo });
    return {
      status: 'skipped',
      target: targetLabel,
      message: preCheck.reason
    };
  }

  const activeBranch = getActiveBranch(targetPath);
  const vars = {
    pkg: sourceRepo.name,
    pkgs: sourceRepo.name,
    sha: triggerContext.sha || '',
    sourcePath: sourceRepo.path,
    targetPath: pkg.path,
    sourceBranch: triggerContext.branch || '',
    targetBranch: activeBranch
  };
  vars.bumps = `${vars.pkg}@${(vars.sha || '').slice(0, 7)}`;

  // Acquire lock
  let lock;
  try {
    lock = await acquireLock(targetPath, { staleLockSec: pkg.staleLockSec || 900 });
  } catch (err) {
    logger.error(`[${targetLabel}] ${err.message}`, { echo });
    return {
      status: 'failed',
      target: targetLabel,
      message: err.message
    };
  }

  try {
    logger.info(`[${targetLabel}] Güncelleme komutları çalıştırılıyor...`, { echo });

    // Run commands sequentially
    for (const rawCmd of pkg.commands) {
      const cmd = interpolateVariables(rawCmd, vars);
      logger.info(`[${targetLabel}] $ ${cmd}`, { echo });

      try {
        const timeoutMs = (pkg.commandTimeout || 300) * 1000;
        await execAsync(cmd, {
          cwd: targetPath,
          timeout: timeoutMs,
          env: { ...process.env, CI: '1' }
        });
      } catch (cmdErr) {
        logger.error(`[${targetLabel}] Komut başarısız: "${cmd}" -> ${cmdErr.message}`, { echo });
        rollbackWorkingTree(targetPath);
        return {
          status: 'failed',
          target: targetLabel,
          message: `Komut hatası: ${cmd}`
        };
      }
    }

    // Check git changes
    const porcelain = execSync('git status --porcelain', { cwd: targetPath, encoding: 'utf8' }).trim();
    if (porcelain.length === 0) {
      logger.info(`[${targetLabel}] Değişiklik yok (güncel).`, { echo });
      return {
        status: 'unchanged',
        target: targetLabel,
        message: 'Değişiklik yok'
      };
    }

    // Changes detected
    const commitMsg = interpolateVariables(pkg.commitMessage || 'chore(deps): bump {bumps}', vars);

    if (dryRun) {
      const diffStat = execSync('git diff --stat', { cwd: targetPath, encoding: 'utf8' }).trim();
      logger.info(`[${targetLabel}] [DRY-RUN] Değişiklikler commit edilmeyecek:\n${diffStat}`, { echo });
      rollbackWorkingTree(targetPath);
      return {
        status: 'committed',
        target: targetLabel,
        message: `[dry-run] -> ${commitMsg}`
      };
    }

    // Stage changes and commit
    execSync('git add -A', { cwd: targetPath });
    execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: targetPath });
    logger.info(`[${targetLabel}] Commit oluşturuldu: "${commitMsg}"`, { echo });

    // Push if configured
    if (pkg.push) {
      logger.info(`[${targetLabel}] Git push çalıştırılıyor...`, { echo });
      try {
        execSync('git push', { cwd: targetPath });
        logger.info(`[${targetLabel}] Push başarılı.`, { echo });
      } catch (pushErr) {
        logger.error(`[${targetLabel}] Push başarısız: ${pushErr.message}`, { echo });
        return {
          status: 'failed',
          target: targetLabel,
          message: `Commit atıldı ancak push başarısız oldu: ${pushErr.message}`
        };
      }
    }

    // Update pending push count
    const pendingPush = getUnpushedCount(targetPath);
    updateState(state => {
      state.repos[targetPath] = {
        lastProcessedSha: vars.sha,
        lastProcessedAt: Date.now(),
        pendingPushCount: pendingPush,
        lastCommitMessage: commitMsg
      };
      return state;
    });

    return {
      status: 'committed',
      target: targetLabel,
      message: commitMsg
    };
  } finally {
    if (lock) {
      lock.release();
    }
  }
}

/**
 * Runs updates for all dependent packages of a source repo.
 * Concurrency is limited to maxConcurrent.
 * @param {object} params
 * @param {object} params.config
 * @param {object} params.sourceRepo
 * @param {object} params.triggerContext
 * @param {boolean} [params.dryRun=false]
 * @param {boolean} [params.echo=false]
 * @returns {Promise<{ committed: number, unchanged: number, failed: number, skipped: number, results: any[] }>}
 */
export async function runSourceRepo({ config, sourceRepo, triggerContext, dryRun = false, echo = false }) {
  const targets = sourceRepo.packages || [];
  if (targets.length === 0) {
    logger.info(`[${sourceRepo.name}] Güncellenecek hedef bağımlılık tanımlanmamış.`, { echo });
    return { committed: 0, unchanged: 0, failed: 0, skipped: 0, results: [] };
  }

  const maxConcurrent = config.defaults?.maxConcurrent || 3;
  const results = [];

  // Throttled concurrency execution
  let index = 0;
  async function worker() {
    while (index < targets.length) {
      const pkg = targets[index++];
      const res = await runTarget({
        sourceRepo,
        pkg,
        triggerContext,
        dryRun,
        echo
      });
      results.push(res);
    }
  }

  const workerCount = Math.min(maxConcurrent, targets.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  const committed = results.filter(r => r.status === 'committed').length;
  const unchanged = results.filter(r => r.status === 'unchanged').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;

  // Record in state
  const runSummary = {
    timestamp: Date.now(),
    sourceRepo: sourceRepo.name,
    trigger: triggerContext.trigger,
    sha: triggerContext.sha ? triggerContext.sha.slice(0, 7) : '',
    committed,
    unchanged,
    failed,
    skipped
  };

  updateState(state => {
    state.lastRuns = [runSummary, ...(state.lastRuns || [])].slice(0, 50);
    if (triggerContext.sha) {
      state.repos[sourceRepo.path] = {
        ...(state.repos[sourceRepo.path] || {}),
        lastProcessedSha: triggerContext.sha,
        lastProcessedAt: Date.now()
      };
    }
    return state;
  });

  // macOS Notification
  const notifType = failed > 0 ? 'fail' : 'ok';
  const notifMsg = `${committed} commit, ${unchanged} güncel, ${failed} hata`;
  sendNotification({
    type: notifType,
    title: `@sqaft/updeps: ${sourceRepo.name}`,
    message: notifMsg,
    enabled: config.notifications !== false
  });

  refreshSwiftBar();

  logger.info(
    `[${sourceRepo.name}] Tamamlandı: ${committed} commit, ${unchanged} güncel, ${failed} hata, ${skipped} atlandı.`,
    { echo }
  );

  return { committed, unchanged, failed, skipped, results };
}
