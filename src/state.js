import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, STATE_FILE } from './paths.js';

export function getDefaultState() {
  return {
    repos: {},
    lastRuns: [],
    daemon: {
      pid: null,
      startedAt: null,
      monitoredCount: 0,
      running: false
    },
    activeRuns: [],
    errors: []
  };
}

/**
 * Loads current runtime state.
 * @returns {object}
 */
export function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return getDefaultState();
  }

  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...getDefaultState(),
      ...parsed,
      repos: parsed.repos || {},
      lastRuns: parsed.lastRuns || [],
      daemon: { ...getDefaultState().daemon, ...(parsed.daemon || {}) },
      activeRuns: parsed.activeRuns || [],
      errors: parsed.errors || []
    };
  } catch {
    return getDefaultState();
  }
}

/**
 * Saves runtime state atomically.
 * @param {object} state
 */
export function saveState(state) {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }

  const tempFile = `${STATE_FILE}.tmp.${Date.now()}`;
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tempFile, STATE_FILE);
}

/**
 * Updates a slice of the state atomically.
 * @param {(currentState: object) => object} updater
 */
export function updateState(updater) {
  const current = loadState();
  const updated = updater(current) || current;
  saveState(updated);
  return updated;
}
