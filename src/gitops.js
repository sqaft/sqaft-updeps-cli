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
    return { ok: false, reason: `Directory does not exist: ${targetPath}` };
  }
  const gitDir = path.join(targetPath, '.git');
  if (!fs.existsSync(gitDir)) {
    return { ok: false, reason: `Not a git repository: ${targetPath}` };
  }
  for (const marker of CONFLICT_MARKERS) {
    if (fs.existsSync(path.join(gitDir, marker))) {
      return { ok: false, reason: `Repo is mid-operation (${marker}), skipped` };
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
 * Paths that changed while the commands ran: present in `after` and either
 * absent from `before` or with a different status code. Not every one of them
 * was written by the commands — another process (an editor, a build watcher)
 * may have touched files in the same window — so callers narrow this list
 * down with the target's `commitPaths` before committing or reverting.
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
 * True when the status snapshot contains an unresolved merge conflict entry.
 * @param {Map<string,string>} snapshot  from `statusSnapshot`
 * @returns {boolean}
 */
export function hasUnmerged(snapshot) {
  return [...snapshot.values()].some((c) => c.includes('U') || c === 'AA' || c === 'DD');
}

/**
 * Stages every change (tracked, deleted and untracked, honoring .gitignore)
 * and commits it with the repo's hooks enabled. For commits the user asked
 * for explicitly — updeps' own automatic commits never use `add -A`.
 * @param {string} cwd
 * @param {string} message
 * @returns {string} the new commit's short sha
 */
export function commitAll(cwd, message) {
  gitOrThrow(['add', '-A'], cwd);
  gitOrThrow(['commit', '-m', message], cwd);
  return git(['rev-parse', '--short', 'HEAD'], cwd, '');
}

const MAX_SQUASH_CHAIN = 50;

/**
 * The commits updeps made earlier that can safely be folded into a new commit
 * sitting right above `tipSha`: the unbroken run of `recorded` commits ending
 * at `tipSha`, newest first. A commit qualifies only when it
 * - is one updeps recorded itself (exact sha, so any amend/rebase/cherry-pick
 *   by the user makes it ineligible),
 * - has exactly one parent and is not reachable from any remote-tracking ref
 *   (never pushed),
 * and the run is dropped entirely when another local branch or a tag also
 * contains its oldest commit. Commits of the user are never part of the run:
 * it ends at the first commit that updeps did not make.
 * @param {string} cwd
 * @param {string} branch   checked-out branch the commits live on
 * @param {string} tipSha   commit the chain ends at (parent of the new commit)
 * @param {Array<{ sha: string, branch: string, sources?: Array<{name:string, sha:string}> }>} recorded
 * @returns {{ commits: typeof recorded, base: string }|null}  `base` is the parent of the oldest commit
 */
export function squashableChain(cwd, branch, tipSha, recorded) {
  if (git(['config', '--type=bool', '--get', 'commit.gpgsign'], cwd, 'false') === 'true') return null;

  const unpushed = new Set(
    git(['rev-list', `--max-count=${MAX_SQUASH_CHAIN}`, tipSha, '--not', '--remotes'], cwd, '')
      .split('\n')
      .filter(Boolean)
  );

  const commits = [];
  let base = null;
  let sha = tipSha;
  while (commits.length < MAX_SQUASH_CHAIN) {
    const entry = recorded.find((e) => e.sha === sha && e.branch === branch);
    if (!entry || !unpushed.has(sha)) break;
    const parents = git(['rev-list', '--parents', '-n', '1', sha], cwd, '').split(' ').slice(1);
    if (parents.length !== 1) break;
    commits.push(entry);
    base = parents[0];
    sha = parents[0];
  }
  if (commits.length === 0) return null;

  const oldest = commits[commits.length - 1].sha;
  // On failure the fallback is not a ref name, so the check below rejects the chain.
  const holders = git(
    ['for-each-ref', '--contains', oldest, '--format=%(refname)', 'refs/heads', 'refs/tags'],
    cwd,
    '\0'
  )
    .split('\n')
    .filter(Boolean);
  if (holders.length !== 1 || holders[0] !== `refs/heads/${branch}`) return null;

  return { commits, base };
}

/**
 * Replaces `newSha` (the tip of `branch`) with one commit that has the same
 * tree but `base` as parent, so every commit between `base` and `newSha`
 * disappears from the branch's history. Only the branch ref moves: index and
 * working tree are untouched, and the tree is identical, so no file content
 * can change. The ref update is compare-and-swap on `newSha` — if anything
 * moved the branch in the meantime nothing happens. Returns the new commit's
 * sha, or null when squashing would be pointless (same tree as `base`) or the
 * ref moved. The replaced commits stay in the reflog.
 * @param {string} cwd
 * @param {{ branch: string, base: string, newSha: string, message: string }} params
 * @returns {string|null}
 */
export function squashOnto(cwd, { branch, base, newSha, message }) {
  const tree = gitOrThrow(['rev-parse', `${newSha}^{tree}`], cwd);
  if (tree === gitOrThrow(['rev-parse', `${base}^{tree}`], cwd)) return null;

  const squashed = gitOrThrow(['commit-tree', tree, '-p', base, '-m', message], cwd);
  const res = spawnSync(
    'git',
    ['update-ref', '-m', 'updeps: squash', `refs/heads/${branch}`, squashed, newSha],
    { cwd, encoding: 'utf8' }
  );
  return res.status === 0 ? squashed : null;
}

/**
 * Content hash (git blob sha) of a working-tree file, or null if it can't be
 * read (e.g. deleted by the command).
 * @param {string} cwd
 * @param {string} filePath  relative to cwd
 * @returns {string|null}
 */
function hashFile(cwd, filePath) {
  const res = spawnSync('git', ['hash-object', '--', filePath], { cwd, encoding: 'utf8' });
  if (res.status !== 0) return null;
  return (res.stdout || '').trim() || null;
}

/**
 * Hashes the working-tree content of each given path. Used to detect a
 * command re-touching a file that was *already* dirty before the run: its
 * `git status` code doesn't change (still e.g. ` M`), so `diffSnapshots`
 * alone can't see it — without this, that update would be silently dropped
 * and reported as "no change" even though the command did change something.
 * @param {string} cwd
 * @param {string[]} paths  relative to cwd
 * @returns {Map<string,string|null>}
 */
export function hashPaths(cwd, paths) {
  const map = new Map();
  for (const p of paths) map.set(p, hashFile(cwd, p));
  return map;
}

/**
 * Undoes a failed (or dry) run: reverts the tracked files that were clean
 * beforehand, changed while the commands ran and match `isCommitPath`. Files
 * dirty before the run are never touched. Changed paths outside
 * `isCommitPath` are left as they are and returned for the caller to report:
 * another process may have written them in the meantime, and reverting them
 * would discard that work. Untracked files are never deleted.
 * @param {string} cwd
 * @param {Map<string,string>} before
 * @param {Map<string,string>} after
 * @param {(filePath: string) => boolean} isCommitPath  from `createPathMatcher(target.commitPaths)`
 * @returns {{ reverted: string[], otherFiles: string[] }}  `otherFiles`: changed paths outside `isCommitPath`, left untouched
 */
export function safeRollback(cwd, before, after, isCommitPath) {
  const { tracked, untracked } = diffSnapshots(before, after);
  const otherFiles = [...tracked, ...untracked].filter((p) => !isCommitPath(p));
  const ownTracked = tracked.filter(isCommitPath);
  const toRevert = ownTracked.filter((p) => !before.has(p));
  let reverted = [];
  if (toRevert.length > 0) {
    try {
      gitOrThrow(['checkout', '--', ...toRevert], cwd);
      reverted = toRevert;
    } catch (err) {
      logger.warn(`[rollback] could not revert: ${err.message}`);
    }
  }
  const keptDirty = ownTracked.filter((p) => before.has(p));
  if (keptDirty.length > 0) {
    logger.warn(
      `[rollback] files that were already dirty before the command were kept, not reverted: ${keptDirty.join(', ')}`
    );
  }
  const ownUntracked = untracked.filter(isCommitPath);
  if (ownUntracked.length > 0) {
    logger.warn(`[rollback] untracked files created by the command were not deleted: ${ownUntracked.join(', ')}`);
  }
  return { reverted, otherFiles };
}

/**
 * @param {string} cwd
 * @returns {string}
 */
export function activeBranch(cwd) {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 'HEAD');
}

/**
 * Where the checked-out branch pushes to and how many commits it is ahead of
 * that remote-tracking ref (as last seen locally; nothing is fetched).
 * `null` when HEAD is detached, the branch has no upstream, or the upstream
 * ref no longer exists.
 * @param {string} cwd
 * @returns {{ branch: string, remote: string, remoteBranch: string, ahead: number }|null}
 */
export function upstreamStatus(cwd) {
  const branch = git(['symbolic-ref', '--short', '-q', 'HEAD'], cwd, '');
  if (!branch) return null;
  const info = git(
    ['for-each-ref', '--format=%(upstream:remotename)%09%(upstream:remoteref)', `refs/heads/${branch}`],
    cwd,
    ''
  );
  const [remote, ref] = info.split('\t');
  if (!remote || remote === '.' || !ref) return null;
  const count = git(['rev-list', '--count', '@{u}..HEAD'], cwd, '');
  if (count === '') return null;
  return { branch, remote, remoteBranch: ref.replace(/^refs\/heads\//, ''), ahead: parseInt(count, 10) };
}

/**
 * Full sha of a remote-tracking ref (`refs/remotes/<remote>/<branch>`), or null.
 * @param {string} cwd
 * @param {string} remote
 * @param {string} branch
 * @returns {string|null}
 */
export function remoteTip(cwd, remote, branch) {
  return git(['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${branch}`], cwd, '') || null;
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
