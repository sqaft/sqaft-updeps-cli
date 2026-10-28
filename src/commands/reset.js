import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';
import {
  CONFIG_FILE,
  LOCKS_DIR,
  LOG_FILE,
  STATE_FILE,
  tildify
} from '../paths.js';
import { resetState } from '../state.js';
import { JOURNAL_FILE, JOURNAL_FILE_1 } from '../journal.js';
import { runningDaemonPid } from '../daemon.js';
import { restartService } from '../service/index.js';

/**
 * Best-effort file removal. Never throws.
 * @param {string} p
 * @returns {boolean} true if a file was actually removed
 */
function rm(p) {
  try {
    if (!fs.existsSync(p)) return false;
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Empties the locks directory. Called only when no daemon owns a live lock.
 * @returns {number} how many lock dirs were removed
 */
function clearLocks() {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(LOCKS_DIR)) {
      if (rm(path.join(LOCKS_DIR, name))) removed++;
    }
  } catch {
    /* no locks dir */
  }
  return removed;
}

/**
 * @param {string} question
 * @returns {Promise<boolean>}
 */
async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return ['y', 'yes'].includes(answer);
  } finally {
    rl.close();
  }
}

/**
 * Wipes every runtime artifact except the config file: run queue, open
 * failures, run history, per-repo SHA tracking, the journal, raw logs and
 * stale lock dirs. A running daemon is restarted afterwards so its in-memory
 * queue is flushed too (skip with `--keep-daemon`).
 * @param {{ yes?: boolean, 'keep-daemon'?: boolean }} opts
 */
export async function cmdReset(opts = {}) {
  const keepDaemon = opts['keep-daemon'] === true;
  const pid = runningDaemonPid();

  if (!opts.yes) {
    console.log(styleText('yellow', 'This permanently deletes:'));
    console.log('  · the pending queue and the running job record');
    console.log('  · all open failures');
    console.log('  · run history (journal) and raw logs');
    console.log('  · per-repo processed SHA tracking and locks');
    console.log(styleText('dim', `Kept: ${tildify(CONFIG_FILE)}`));
    if (pid && !keepDaemon) {
      console.log(styleText('dim', `The daemon (pid ${pid}) will be restarted.`));
    }
    console.log('');

    if (!process.stdin.isTTY) {
      console.error(styleText('red', 'Confirmation required. In a non-interactive environment: updeps reset --yes'));
      process.exit(1);
    }
    if (!(await confirm('Continue? [y/N] '))) {
      console.log('Cancelled.');
      return;
    }
  }

  // 1. state.json → empty (the daemon block is kept if a daemon is running)
  resetState({ preserveDaemon: pid != null });
  const wipedState = fs.existsSync(STATE_FILE);

  // 2. journal + its rotated file
  const wipedJournal = [JOURNAL_FILE, JOURNAL_FILE_1].map(rm).some(Boolean);

  // 3. raw log — the service manager keeps the file open, so truncate it instead of deleting
  let wipedLog = false;
  try {
    if (fs.existsSync(LOG_FILE)) {
      fs.truncateSync(LOG_FILE, 0);
      wipedLog = true;
    }
  } catch {
    /* ignore */
  }

  // 4. daemon: restart (this also clears the in-memory queue)
  let daemonNote = '';
  if (pid && !keepDaemon) {
    try {
      await restartService(); // releaseHeldLocks() also releases the locks on shutdown
      daemonNote = 'daemon restarted';
    } catch (err) {
      daemonNote = styleText('red', `failed to restart daemon: ${err.message}`);
    }
  } else if (pid) {
    daemonNote = styleText('yellow', `daemon is running (pid ${pid}) — "updeps restart" is needed to clear the in-memory queue`);
  }

  // 5. locks — safe to clear once the daemon is stopped
  const daemonStopped = runningDaemonPid() == null;
  const locksRemoved = daemonStopped || !keepDaemon ? clearLocks() : 0;

  const done = [];
  if (wipedState) done.push('queue + failures + history');
  if (wipedJournal) done.push('journal');
  if (wipedLog) done.push('logs');
  if (locksRemoved) done.push(`${locksRemoved} lock(s)`);

  console.log(styleText('green', `Cleared: ${done.join(', ') || 'already empty'}`));
  if (daemonNote) console.log(styleText('dim', daemonNote));
}
