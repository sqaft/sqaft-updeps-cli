import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, STATE_FILE } from './paths.js';

const EMPTY_STATE = {
  repos: {},          // sourcePath|targetPath -> { lastProcessedSha, lastProcessedAt, lastUpdatedFrom, lastUpdatedSha, lastUpdatedAt, lastCommitMessage }
  lastRuns: [],       // [{ timestamp, sourceRepo, trigger, sha, committed, unchanged, failed, skipped }]
  openFailures: [],   // [{ id, source, target, targetPath, message, errorTail, firstSeen, lastSeen, count }]
  activeRun: null,    // { group, source, target, targetPath, startedAt } — what is running right now
  queue: { pending: 0, jobs: [] }, // { pending, jobs:[{ target, targetPath, sources:[name] }] } — waiting behind activeRun
  daemon: null,       // { pid, startedAt, watchedRepos }
  reflogTips: {}      // reflogFilePath -> last-seen sha; lets the watcher catch up on pushes made while the daemon was down
};

/**
 * Reads the state file. Returns a fresh empty state if missing or corrupt.
 * @returns {typeof EMPTY_STATE}
 */
export function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...structuredClone(EMPTY_STATE), ...parsed };
  } catch {
    return structuredClone(EMPTY_STATE);
  }
}

/**
 * Writes state atomically (temp file + rename).
 * @param {object} state
 */
export function saveState(state) {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  const tmp = path.join(STATE_DIR, `.state.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

/**
 * Wipes all runtime state back to empty. The config file is untouched — this
 * only clears `state.json` (queue, open failures, run history, per-repo SHA
 * tracking). When a daemon is running, its `daemon` block is preserved so
 * `status` keeps reporting the live process.
 * @param {object} [opts]
 * @param {boolean} [opts.preserveDaemon=false]
 * @returns {typeof EMPTY_STATE} the saved (empty) state
 */
export function resetState({ preserveDaemon = false } = {}) {
  const fresh = structuredClone(EMPTY_STATE);
  if (preserveDaemon) {
    const current = loadState();
    if (current.daemon) fresh.daemon = current.daemon;
  }
  saveState(fresh);
  return fresh;
}

/**
 * Loads state, applies a mutator, and saves the result.
 * The mutator may return the state or mutate it in place.
 * @param {(state: any) => any} mutator
 * @returns {any} the saved state
 */
export function updateState(mutator) {
  const state = loadState();
  const next = mutator(state) || state;
  saveState(next);
  return next;
}
