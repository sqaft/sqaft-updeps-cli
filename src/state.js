import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, STATE_FILE } from './paths.js';

const EMPTY_STATE = {
  repos: {},          // sourcePath|targetPath -> { lastProcessedSha, lastProcessedAt, pendingPushCount, lastCommitMessage }
  lastRuns: [],       // [{ timestamp, sourceRepo, trigger, sha, committed, unchanged, failed, skipped }]
  openFailures: [],   // [{ id, source, target, targetPath, message, errorTail, firstSeen, lastSeen, count }]
  activeRun: null,    // { group, source, target, targetPath, startedAt } — what is running right now
  queue: { pending: 0 }, // { pending } — jobs waiting behind activeRun
  daemon: null        // { pid, startedAt, watchedRepos }
};

/**
 * Reads the state file. Returns a fresh empty state if missing or corrupt.
 * @returns {typeof EMPTY_STATE}
 */
export function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const merged = { ...structuredClone(EMPTY_STATE), ...parsed };
    // Drop keys from older schema versions (e.g. `activeRuns`, `errors`) so a
    // stale file written by an old daemon can't shadow the current shape.
    for (const key of Object.keys(merged)) {
      if (!(key in EMPTY_STATE)) delete merged[key];
    }
    return merged;
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
