import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git, gitOrThrow } from './exec.js';
import { logger } from './logger.js';

const CONFLICT_MARKERS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];

/**
 * @param {string} targetPath
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkPreconditions(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return { ok: false, reason: `Dizin yok: ${targetPath}` };
  }
  const gitDir = path.join(targetPath, '.git');
  if (!fs.existsSync(gitDir)) {
    return { ok: false, reason: `Git reposu değil: ${targetPath}` };
  }
  for (const marker of CONFLICT_MARKERS) {
    if (fs.existsSync(path.join(gitDir, marker))) {
      return { ok: false, reason: `Repo işlem ortasında (${marker}), atlandı` };
    }
  }
  return { ok: true };
}

/**
 * Parses `git status --porcelain=v1 -z` into a map of path -> XY status code.
 * Rename/copy entries record the destination path.
 * @param {string} cwd
 * @returns {Map<string,string>}
 */
export function statusSnapshot(cwd) {
  const proc = spawnSync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd, encoding: 'utf8' }
  );
  const map = new Map();
  if (proc.status !== 0 || !proc.stdout) return map;

  const tokens = proc.stdout.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const p = entry.slice(3);
    map.set(p, code);
    // rename/copy: the following token is the source path, skip it
    if (code[0] === 'R' || code[0] === 'C') i++;
  }
  return map;
}

/**
 * Paths that the commands touched: present in `after` and either absent from
 * `before` or with a different status code.
 * @param {Map<string,string>} before
 * @param {Map<string,string>} after
 * @returns {{ tracked: string[], untracked: string[] }}
 */
export function diffSnapshots(before, after) {
  const tracked = [];
  const untracked = [];
  for (const [p, code] of after) {
    if (before.get(p) === code) continue;
    if (code === '??') untracked.push(p);
    else tracked.push(p);
  }
  return { tracked, untracked };
}

/**
 * Stages and commits exactly the given paths. Nothing else is touched.
 * @param {string} cwd
 * @param {string[]} paths
 * @param {string} message
 * @returns {string} the new commit's short sha
 */
export function selectiveCommit(cwd, paths, message) {
  gitOrThrow(['add', '--', ...paths], cwd);
  gitOrThrow(['commit', '--no-verify', '-m', message, '--', ...paths], cwd);
  return git(['rev-parse', '--short', 'HEAD'], cwd, '');
}

/**
 * Reverts only the changes the commands made to files that were clean
 * beforehand. Files dirty before the run are never touched. Newly created
 * untracked files are left in place and reported.
 * @param {string} cwd
 * @param {Map<string,string>} before
 * @param {Map<string,string>} after
 */
export function safeRollback(cwd, before, after) {
  const { tracked, untracked } = diffSnapshots(before, after);
  const toRevert = tracked.filter((p) => !before.has(p));
  if (toRevert.length > 0) {
    try {
      gitOrThrow(['checkout', '--', ...toRevert], cwd);
    } catch (err) {
      logger.warn(`[rollback] geri alınamadı: ${err.message}`);
    }
  }
  const keptDirty = tracked.filter((p) => before.has(p));
  if (keptDirty.length > 0) {
    logger.warn(
      `[rollback] komut öncesi zaten kirli olan dosyalar korundu, geri alınmadı: ${keptDirty.join(', ')}`
    );
  }
  if (untracked.length > 0) {
    logger.warn(`[rollback] komutun oluşturduğu takipsiz dosyalar silinmedi: ${untracked.join(', ')}`);
  }
}

/**
 * @param {string} cwd
 * @returns {string}
 */
export function activeBranch(cwd) {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 'HEAD');
}

/**
 * Default branch as recorded by origin/HEAD, falling back to 'main'.
 * @param {string} cwd
 * @returns {string}
 */
export function defaultBranch(cwd) {
  const ref = git(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd, '');
  if (ref) return ref.replace('refs/remotes/origin/', '');
  return 'main';
}
