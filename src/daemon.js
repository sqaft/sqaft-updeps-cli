import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { LOG_FILE, LOGS_DIR, PID_FILE, SUPERVISOR_PID_FILE, STATE_DIR } from './paths.js';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { loadState, updateState } from './state.js';
import { UpdateQueue } from './queue.js';
import { releaseHeldLocks } from './lock.js';
import { ReflogWatcher } from './watcher.js';
import { notifyRunGroup } from './runner.js';
import { startControlServer } from './control.js';
import { BIN_PATH } from './launcher.js';

/**
 * Exit code of a daemon or supervisor that found another one already running.
 * Service managers and the supervisor do not restart a process that exits with it.
 */
export const EXIT_ALREADY_RUNNING = 3;

/**
 * pid recorded in a pid file, if that process is alive.
 * @param {string} file
 * @returns {number|null}
 */
function livePidFrom(file) {
  try {
    const pid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    if (!pid) return null;
    process.kill(pid, 0); // throws if not alive
    return pid;
  } catch {
    return null;
  }
}

/**
 * @returns {number|null} pid of a live daemon, or null
 */
export function runningDaemonPid() {
  return livePidFrom(PID_FILE);
}

/**
 * @returns {number|null} pid of a live supervisor (see `runSupervisor`), or null
 */
export function runningSupervisorPid() {
  return livePidFrom(SUPERVISOR_PID_FILE);
}

/**
 * Removes a pid file if it still records this process.
 * @param {string} file
 */
function removeOwnPidFile(file) {
  try {
    if (parseInt(fs.readFileSync(file, 'utf8').trim(), 10) === process.pid) fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * The long-running daemon process. Blocks until SIGTERM/SIGINT or a
 * `shutdown` request on the control channel.
 */
export async function runDaemon() {
  if (runningDaemonPid()) {
    logger.error('Daemon is already running.');
    process.exit(EXIT_ALREADY_RUNNING);
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');

  let config = loadConfig();
  logger.info(`Daemon started (pid ${process.pid}), ${config.repos.length} source repos.`);
  for (const w of config.warnings) logger.warn(`config: ${w}`);

  const queue = new UpdateQueue(config, {
    onGroupDone: ({ title, tally }) => {
      notifyRunGroup({ notifications: config.notifications, title, tally });
    }
  });

  const watcher = new ReflogWatcher(config, queue, () => {
    try {
      config = loadConfig();
      queue.updateConfig(config);
      watcher.config = config;
      watcher.start();
      updateState((s) => {
        s.daemon = { ...(s.daemon || {}), watchedRepos: config.repos.length };
        return s;
      });
      logger.info(`Config reloaded: ${config.repos.length} source repos.`);
      for (const w of config.warnings) logger.warn(`config: ${w}`);
    } catch (err) {
      logger.error(`Config reload failed, keeping previous settings: ${err.message}`);
    }
  });
  watcher.start();

  updateState((s) => {
    s.daemon = {
      pid: process.pid,
      startedAt: Date.now(),
      watchedRepos: config.repos.length
    };
    // A fresh daemon owns an empty queue; drop anything a crashed run left behind.
    s.activeRun = null;
    s.queue = { pending: 0, jobs: [] };
    return s;
  });

  let control = null;
  let shuttingDown = false;
  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${reason}, shutting down...`);
    control?.close();
    await watcher.stop();
    await queue.shutdown(); // abort + await any in-flight command before releasing its lock
    releaseHeldLocks(); // don't strand an in-flight run's lock across a restart
    updateState((s) => {
      s.daemon = null;
      s.activeRun = null;
      s.queue = { pending: 0, jobs: [] };
      return s;
    });
    removeOwnPidFile(PID_FILE);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    control = await startControlServer({
      ping: () => ({ pid: process.pid }),
      shutdown: () => {
        setImmediate(() => shutdown('a shutdown request'));
        return {};
      }
    });
  } catch (err) {
    logger.warn(`Control channel unavailable (${err.message}); "updeps stop" falls back to killing the process.`);
  }

  // Keep the event loop alive.
  await new Promise(() => {});
}

/**
 * Starts `updeps daemon --supervise` as a detached background process with no
 * console window, and returns without waiting for it.
 * @param {Record<string,string>} [env]
 */
export function spawnSupervisor(env = process.env) {
  const child = spawn(process.execPath, [BIN_PATH, 'daemon', '--supervise'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env
  });
  child.unref();
}

/**
 * Keeps a daemon running where no service manager does it (Windows, Linux
 * without a systemd user session): runs `updeps daemon` as a child with its
 * output appended to the log file, and restarts it with a growing delay
 * (1s, doubling up to 60s; reset after a minute of uptime) when it exits with
 * an error. A clean exit (a shutdown request) or "already running" ends the
 * supervisor too. SIGTERM/SIGINT are forwarded to the daemon.
 */
export async function runSupervisor() {
  if (runningSupervisorPid()) process.exit(EXIT_ALREADY_RUNNING);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SUPERVISOR_PID_FILE, String(process.pid), 'utf8');

  let stopping = false;
  let child = null;
  const stop = () => {
    stopping = true;
    if (child) child.kill('SIGTERM');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  let delay = 1000;
  while (!stopping) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const out = fs.openSync(LOG_FILE, 'a');
    const startedAt = Date.now();
    child = spawn(process.execPath, [BIN_PATH, 'daemon'], { stdio: ['ignore', out, out], windowsHide: true });
    fs.closeSync(out);
    const code = await new Promise((resolve) => {
      child.once('error', () => resolve(1));
      child.once('exit', (exitCode) => resolve(exitCode ?? 1));
    });
    child = null;
    if (stopping || code === 0 || code === EXIT_ALREADY_RUNNING) break;

    delay = Date.now() - startedAt > 60_000 ? 1000 : Math.min(delay * 2, 60_000);
    logger.warn(`[supervisor] daemon exited with code ${code}, restarting in ${delay / 1000}s`);
    await sleep(delay);
  }

  removeOwnPidFile(SUPERVISOR_PID_FILE);
  process.exit(0);
}

/**
 * `updeps daemon --detach`: what the login script runs. Starts the supervisor
 * in the background unless one is already running, then exits, so the
 * console window the login script opens closes right away.
 */
export function detachDaemon() {
  if (!runningSupervisorPid() && !runningDaemonPid()) spawnSupervisor();
}

/**
 * Newest mtime (ms) across the shipped `src/` and `bin/` JS, or 0.
 * @returns {number}
 */
function newestSourceMtime() {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        try {
          newest = Math.max(newest, fs.statSync(full).mtimeMs);
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(fileURLToPath(new URL('.', import.meta.url)));
  walk(fileURLToPath(new URL('../bin/', import.meta.url)));
  return newest;
}

/**
 * True when a daemon is running but its code was modified after it started —
 * i.e. it is serving stale modules and needs `updeps restart`.
 * @returns {boolean}
 */
export function daemonCodeStale() {
  if (!runningDaemonPid()) return false;
  const startedAt = loadState().daemon?.startedAt;
  if (!startedAt) return false;
  const newest = newestSourceMtime();
  return newest > 0 && newest > startedAt + 2000; // 2s grace for clock skew
}
