import { setTimeout as sleep } from 'node:timers/promises';
import { spawnSupervisor, runningDaemonPid, runningSupervisorPid } from '../daemon.js';
import { sendControl } from '../control.js';
import { launchPath } from '../launcher.js';
import { updateState } from '../state.js';

/**
 * Polls until `predicate` holds or the timeout passes.
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} the final value of `predicate`
 */
export async function waitUntil(predicate, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
}

const stopped = () => !runningDaemonPid() && !runningSupervisorPid();

/**
 * Waits until a daemon answers on the control channel, which it opens once it
 * has fully started.
 * @param {number} timeoutMs
 * @returns {Promise<number|null>} its pid, or null on timeout
 */
export async function waitForDaemon(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const reply = await sendControl('ping', { timeoutMs: 500 });
    if (reply?.ok) return reply.pid;
    await sleep(100);
  }
  return null;
}

/**
 * Starts the daemon under the supervisor (`updeps daemon --supervise`), with the
 * launch PATH, and waits until it is up. A running daemon is stopped first.
 */
export async function start() {
  await stop();
  spawnSupervisor({ ...process.env, PATH: launchPath() });
  if (!(await waitForDaemon(10_000))) {
    throw new Error('The daemon did not start; see "updeps logs".');
  }
}

/**
 * Asks the daemon to shut down over the control channel (it finishes rolling
 * back an in-flight command first) and waits for it and the supervisor to
 * exit. If it does not answer, the supervisor is killed first, so it cannot
 * restart the daemon, then the daemon.
 */
export async function stop() {
  if (stopped()) return;
  const reply = await sendControl('shutdown');
  if (reply?.ok && (await waitUntil(stopped, 30_000))) return;

  for (const pid of [runningSupervisorPid(), runningDaemonPid()]) {
    if (!pid) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
  }
  await waitUntil(stopped, 10_000);
  // On Windows a killed daemon could not clean up after itself.
  if (!runningDaemonPid()) {
    updateState((s) => {
      s.daemon = null;
      s.activeRun = null;
      s.queue = { pending: 0, jobs: [] };
      return s;
    });
  }
}
