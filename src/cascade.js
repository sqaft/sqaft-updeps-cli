import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { git, gitOrThrow } from './exec.js';
import {
  checkPreconditions,
  upstreamStatus,
  remoteTip,
  statusSnapshot,
  hasUnmerged,
  commitAll
} from './gitops.js';
import { acquireLock } from './lock.js';
import { watchedBranches, watchesPush } from './watcher.js';
import { loadState } from './state.js';
import { readEvents } from './journal.js';
import { redact } from './redact.js';

const SKIPPED_DIRS = new Set(['node_modules', 'vendor']);
/** Extra time (beyond the debounce window) an idle daemon gets to pick up a push. */
const PICKUP_GRACE_MS = 15_000;

/**
 * Real path when the path exists, otherwise its resolved form. On Windows the
 * native call also expands 8.3 short names (`RUNNER~1`), as `git rev-parse`
 * does, so the same repo always gets the same path.
 */
const realpath = process.platform === 'win32' ? fs.realpathSync.native : fs.realpathSync;
function canon(p) {
  try {
    return realpath(p);
  } catch {
    return path.resolve(p);
  }
}

function hasGitDir(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

/**
 * Git repos in scope for a cascade run: the repo `cwd` is in (`cwd` may be any
 * subdirectory of it) plus every repo directly below `cwd`, one level deep
 * (`node_modules`, `vendor` and dot-directories are skipped). Either part may
 * be empty, so a workspace repo that holds project repos covers them all.
 * Paths are real paths.
 * @param {string} cwd
 * @returns {string[]}
 */
export function discoverRepos(cwd) {
  const dir = canon(cwd);
  const found = [];
  const top = git(['rev-parse', '--show-toplevel'], dir, '');
  if (top) found.push(canon(top));

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // unreadable directory: only the enclosing repo (if any) is in scope
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (hasGitDir(full)) found.push(canon(full));
  }
  return found.sort();
}

/**
 * Source→target relations of the config keyed by real path.
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 * @returns {{
 *   parents: Map<string, Set<string>>,
 *   children: Map<string, Set<string>>,
 *   sources: Map<string, object>,
 *   targetPaths: Map<string, string>
 * }}
 */
export function buildGraph(config) {
  const parents = new Map();
  const children = new Map();
  const sources = new Map();
  /** real path -> the path as configured (what the daemon's per-target lock is keyed by) */
  const targetPaths = new Map();
  const link = (map, key, value) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  };
  for (const repo of config.repos) {
    const sourcePath = canon(repo.path);
    sources.set(sourcePath, repo);
    for (const pkg of repo.packages) {
      const targetPath = canon(pkg.path);
      targetPaths.set(targetPath, pkg.path);
      link(parents, targetPath, sourcePath);
      link(children, sourcePath, targetPath);
    }
  }
  return { parents, children, sources, targetPaths };
}

/**
 * Every repo that (transitively) feeds `repoPath`. Contains `repoPath` itself
 * only when it sits on a dependency cycle.
 * @param {string} repoPath
 * @param {ReturnType<typeof buildGraph>} graph
 * @returns {Set<string>}
 */
export function ancestorsOf(repoPath, graph) {
  const seen = new Set();
  const stack = [...(graph.parents.get(repoPath) || [])];
  while (stack.length > 0) {
    const node = stack.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    for (const up of graph.parents.get(node) || []) stack.push(up);
  }
  return seen;
}

/**
 * The repos that may be pushed right now: those without a *blocking* ancestor.
 * Pushing a repo while one of its ancestors still has to be pushed would make
 * the daemon update it twice (once per push), so it waits until the ancestor's
 * update has been applied and can go out in the same push.
 * @param {string[]} ahead     repos with unpushed commits
 * @param {ReturnType<typeof buildGraph>} graph
 * @param {Set<string>} [blocking]  subset of `ahead` whose push triggers the daemon (default: all)
 * @returns {string[]}
 */
export function pickPushable(ahead, graph, blocking = new Set(ahead)) {
  return ahead.filter((repoPath) => {
    for (const ancestor of ancestorsOf(repoPath, graph)) {
      if (ancestor !== repoPath && blocking.has(ancestor)) return false;
    }
    return true;
  });
}

/**
 * @typedef {object} RepoInfo
 * @property {string} path
 * @property {string} label
 * @property {string} [skip]          why the repo is left out
 * @property {string} [branch]
 * @property {string} [remote]
 * @property {string} [remoteBranch]
 * @property {number} [ahead]
 * @property {boolean} [watched]      the daemon reacts to a push of this branch
 */

/**
 * @param {string} repoPath
 * @param {ReturnType<typeof buildGraph>} graph
 * @returns {RepoInfo}
 */
export function inspectRepo(repoPath, graph) {
  const label = path.basename(repoPath);
  const pre = checkPreconditions(repoPath);
  if (!pre.ok) return { path: repoPath, label, skip: pre.reason };
  const up = upstreamStatus(repoPath);
  if (!up) return { path: repoPath, label, skip: 'no upstream, or HEAD is detached' };
  const source = graph.sources.get(repoPath);
  return { path: repoPath, label, ...up, watched: Boolean(source) && watchesPush(source, up.remote, up.remoteBranch) };
}

/**
 * @param {string[]} repos
 * @param {ReturnType<typeof buildGraph>} graph
 * @returns {RepoInfo[]}
 */
export function inspectAll(repos, graph) {
  return repos.map((p) => inspectRepo(p, graph));
}

/**
 * Dry-run forecast of the rounds `runCascade` would take. After a repo is
 * pushed, its direct targets inside the scope are *possibly* ahead next round
 * (the daemon may commit an update there).
 * @param {RepoInfo[]} infos
 * @param {ReturnType<typeof buildGraph>} graph
 * @returns {Array<{ repos?: Array<{ path: string, certain: boolean }>, stuck?: string[] }>}
 */
export function planRounds(infos, graph) {
  const byPath = new Map(infos.filter((i) => !i.skip).map((i) => [i.path, i]));
  const ahead = new Map();
  for (const info of byPath.values()) if (info.ahead > 0) ahead.set(info.path, true);
  const pushed = new Set();
  const rounds = [];

  while (ahead.size > 0 && rounds.length <= byPath.size) {
    const blocking = new Set([...ahead.keys()].filter((p) => byPath.get(p).watched));
    const frontier = pickPushable([...ahead.keys()], graph, blocking);
    if (frontier.length === 0) {
      rounds.push({ stuck: [...ahead.keys()] });
      break;
    }
    rounds.push({ repos: frontier.map((p) => ({ path: p, certain: ahead.get(p) })) });
    for (const p of frontier) {
      ahead.delete(p);
      pushed.add(p);
      if (!byPath.get(p).watched) continue;
      for (const child of graph.children.get(p) || []) {
        if (byPath.has(child) && !ahead.has(child) && !pushed.has(child)) ahead.set(child, false);
      }
    }
  }
  return rounds;
}

/**
 * Source repos the daemon reacts to pushes of, with the branches it watches.
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} config
 * @returns {Array<{ statePath: string, path: string, name: string, branches: string[] }>}
 */
function buildWatchList(config) {
  const list = [];
  for (const repo of config.repos) {
    if (!repo.packages.some((p) => p.triggers.includes('push'))) continue;
    list.push({ statePath: repo.path, path: canon(repo.path), name: repo.name, branches: watchedBranches(repo) });
  }
  return list;
}

const tipKey = (repoPath, branch) => `${repoPath}\0${branch}`;

function snapshotTips(watchList) {
  const tips = new Map();
  for (const w of watchList) {
    for (const branch of w.branches) {
      const tip = remoteTip(w.path, 'origin', branch);
      if (tip) tips.set(tipKey(w.path, branch), tip);
    }
  }
  return tips;
}

/**
 * Watched sources whose `origin` tip moved since `snapshot` — each is a push
 * the daemon has to process. Pushes the daemon itself makes (`push: true`
 * targets) show up here too, since this is re-evaluated on every poll.
 */
function pendingPushes(watchList, snapshot) {
  const out = [];
  for (const w of watchList) {
    const tips = [];
    for (const branch of w.branches) {
      const tip = remoteTip(w.path, 'origin', branch);
      if (tip && tip !== snapshot.get(tipKey(w.path, branch))) tips.push(tip);
    }
    if (tips.length > 0) out.push({ ...w, tips });
  }
  return out;
}

function formatMs(ms) {
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Blocks until the daemon has processed every push that happened since
 * `snapshot` and is idle. The daemon marks a source's push as handled by
 * writing its sha to `state.repos[<source>].lastProcessedSha` once all targets
 * of that push have finished.
 * @returns {Promise<Array<{ name: string }>>} the pushes that were processed
 */
async function waitForDaemon({ watchList, snapshot, isDaemonAlive, pollMs, idleTimeoutMs, progress }) {
  const startedAt = Date.now();
  let okStreak = 0;
  let idleSince = Date.now();
  let lastPendingKey = null;

  for (;;) {
    if (!isDaemonAlive()) throw new Error('The daemon is not running. Start it with "updeps start", then run the command again.');

    const state = loadState();
    const pushes = pendingPushes(watchList, snapshot);
    const unprocessed = pushes.filter((p) => !p.tips.includes(state.repos[p.statePath]?.lastProcessedSha));
    const busy = Boolean(state.activeRun) || state.queue.pending > 0;

    if (unprocessed.length === 0 && !busy) {
      // Two idle polls in a row, so a handoff between two jobs isn't mistaken for "done".
      if (++okStreak >= 2) return pushes;
    } else {
      okStreak = 0;
    }

    const pendingKey = unprocessed.map((p) => p.name).join('|');
    if (busy || pendingKey !== lastPendingKey) {
      idleSince = Date.now();
      lastPendingKey = pendingKey;
    } else if (unprocessed.length > 0 && Date.now() - idleSince > idleTimeoutMs) {
      throw new Error(
        `The daemon is idle but the pushes were not processed (${unprocessed.map((p) => p.name).join(', ')}). ` +
          'It may not be watching this repo or branch; check with "updeps doctor" and "updeps logs".'
      );
    }

    const run = state.activeRun;
    const queued = state.queue.pending > 0 ? ` (+${state.queue.pending} queued)` : '';
    progress(
      run
        ? `daemon running: ${run.source} → ${run.target} ${formatMs(Date.now() - run.startedAt)}${queued}`
        : unprocessed.length > 0
          ? `waiting for daemon: ${unprocessed.map((p) => p.name).join(', ')} ${formatMs(Date.now() - startedAt)}${queued}`
          : `finishing${queued}`
    );
    await sleep(pollMs);
  }
}

/**
 * Target outcomes the daemon journaled for the groups of the given sources
 * since `since`.
 * @returns {Array<{ source: string, target: string, status: string, message: string, commitSha?: string }>}
 */
function collectResults(since, sourceNames) {
  const events = readEvents({
    includeRotated: false,
    filter: (rec) => Date.parse(rec.ts) >= since
  });
  const groups = new Set(
    events.filter((e) => e.kind === 'group_start' && sourceNames.has(e.source)).map((e) => e.group)
  );
  return events
    .filter((e) => e.kind === 'target' && (groups.has(e.group) || (e.groups || []).some((g) => groups.has(g))))
    .reverse()
    .map(({ source, target, status, message, commitSha }) => ({ source, target, status, message, commitSha }));
}

/**
 * Number of changed paths (tracked, deleted, untracked) in a repo.
 * @param {string} repoPath
 * @returns {number}
 */
export function changedFileCount(repoPath) {
  return statusSnapshot(repoPath).size;
}

/**
 * Commits all changes of every pushable repo in scope with `message`. Runs
 * under the repo's updeps lock (the daemon's per-target lock), so it never
 * overlaps an update job. Aborts with an error at the first repo that cannot
 * be committed (conflicts, failing hook, ...) — before anything is pushed.
 * @param {string[]} repos
 * @param {ReturnType<typeof buildGraph>} graph
 * @param {string} message
 * @param {(line: string) => void} log
 * @returns {Promise<Array<{ label: string, path: string, files: number, sha: string }>>}
 */
async function commitChanges(repos, graph, message, log) {
  const committed = [];
  for (const info of inspectAll(repos, graph)) {
    if (info.skip || changedFileCount(info.path) === 0) continue;

    const lock = await acquireLock(graph.targetPaths.get(info.path) ?? info.path, { waitTimeoutSec: 60 });
    try {
      const snapshot = statusSnapshot(info.path);
      if (snapshot.size === 0) continue; // changed while waiting for the lock
      if (hasUnmerged(snapshot)) throw new Error('unresolved merge conflicts');
      const sha = commitAll(info.path, message);
      committed.push({ label: info.label, path: info.path, files: snapshot.size, sha });
      log(`Commit: ${info.label} (${snapshot.size} ${snapshot.size === 1 ? 'file' : 'files'}) ${sha}`);
    } catch (err) {
      const done = committed.length > 0 ? ` (already committed: ${committed.map((c) => c.label).join(', ')})` : '';
      throw new Error(`[${info.label}] commit failed, nothing was pushed${done}: ${redact(err.message)}`);
    } finally {
      lock.release();
    }
  }
  return committed;
}

/**
 * Pushes unpushed commits in dependency order and waits for the daemon after
 * each round, until nothing is left to push.
 *
 * Each round pushes only the repos that have no ancestor (in the config
 * graph) with unpushed commits of its own. A→B→C: B is held back until A's
 * push has been applied to it, so C gets one update from B instead of one per
 * push. Throws when a push fails, the daemon dies or ignores a push; returns
 * `failed` when the daemon reports failed targets (the run stops there).
 * @param {object} params
 * @param {ReturnType<import('./config.js').resolveConfig>} params.config
 * @param {string[]} params.repos      real paths in scope (see `discoverRepos`)
 * @param {() => boolean} params.isDaemonAlive
 * @param {number} [params.pollMs=1000]
 * @param {(line: string) => void} [params.log]
 * @param {(text: string) => void} [params.progress]  live status while waiting
 * @param {number} [params.maxRounds=50]
 * @param {string} [params.commitMessage]  commit every pushable repo's pending changes with this message before the first push
 * @returns {Promise<{ rounds: Array<{ pushed: object[], results: object[] }>, failed: object[], skipped: RepoInfo[], committed: object[] }>}
 */
export async function runCascade({
  config,
  repos,
  isDaemonAlive,
  pollMs = 1000,
  log = () => {},
  progress = () => {},
  maxRounds = 50,
  commitMessage
}) {
  const graph = buildGraph(config);
  const watchList = buildWatchList(config);
  const idleTimeoutMs = (config.defaults.debounceMs ?? 3000) + PICKUP_GRACE_MS;
  const wait = (snapshot) =>
    waitForDaemon({ watchList, snapshot, isDaemonAlive, pollMs, idleTimeoutMs, progress });

  const rounds = [];
  const skipped = inspectAll(repos, graph).filter((i) => i.skip);

  // Let any update the daemon is already working on land before the first push.
  await wait(snapshotTips(watchList));

  const committed = commitMessage ? await commitChanges(repos, graph, commitMessage, log) : [];

  for (let n = 1; n <= maxRounds; n++) {
    const ahead = inspectAll(repos, graph).filter((i) => !i.skip && i.ahead > 0);
    if (ahead.length === 0) return { rounds, failed: [], skipped, committed };

    const blocking = new Set(ahead.filter((i) => i.watched).map((i) => i.path));
    const frontier = pickPushable(
      ahead.map((i) => i.path),
      graph,
      blocking
    ).map((p) => ahead.find((i) => i.path === p));
    if (frontier.length === 0) {
      throw new Error(
        `Cannot determine push order (dependency cycle?): ${ahead.map((i) => i.label).join(', ')}`
      );
    }

    const snapshot = snapshotTips(watchList);
    const roundStart = Date.now();
    const pushed = [];
    for (const info of frontier) {
      log(`Round ${n}: push → ${info.label} (${info.branch}, ${info.ahead} ${info.ahead === 1 ? 'commit' : 'commits'})`);
      try {
        gitOrThrow(['push', info.remote, `HEAD:refs/heads/${info.remoteBranch}`], info.path);
      } catch (err) {
        throw new Error(`[${info.label}] ${redact(err.message)}`);
      }
      if ((upstreamStatus(info.path)?.ahead ?? 0) > 0) {
        throw new Error(`[${info.label}] unpushed commits remain after the push (check the remote configuration).`);
      }
      pushed.push({ label: info.label, path: info.path, branch: info.branch, commits: info.ahead });
    }

    const processed = await wait(snapshot);
    progress('');
    const results = collectResults(roundStart, new Set(processed.map((p) => p.name)));
    rounds.push({ pushed, results });

    for (const r of results.filter((x) => x.status === 'committed')) {
      log(`  ✓ ${r.target} ← ${r.source}${r.commitSha ? ` (${r.commitSha})` : ''}`);
    }
    const failed = results.filter((x) => x.status === 'failed');
    for (const r of failed) log(`  ✗ ${r.target} ← ${r.source}: ${r.message}`);
    const count = (s) => results.filter((x) => x.status === s).length;
    log(`  daemon: ${count('committed')} committed, ${count('unchanged')} up to date, ${failed.length} failed, ${count('skipped')} skipped`);
    if (failed.length > 0) return { rounds, failed, skipped, committed };
  }
  throw new Error(`Did not finish within ${maxRounds} rounds, stopped.`);
}
