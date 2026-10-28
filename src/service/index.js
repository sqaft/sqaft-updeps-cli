import fs from 'node:fs';
import { CONFIG_FILE, LAUNCH_AGENT_PLIST, LOGS_DIR, STARTUP_SCRIPT, SYSTEMD_UNIT_FILE } from '../paths.js';
import { loadConfig } from '../config.js';
import { loadState } from '../state.js';
import { runningDaemonPid, daemonCodeStale } from '../daemon.js';
import * as launchd from './launchd.js';
import * as systemd from './systemd.js';
import * as startup from './startup.js';
import * as supervised from './supervised.js';

/**
 * @typedef {object} ServiceInspection  what the installed service definition will run
 * @property {boolean} installed
 * @property {string|null} node
 * @property {string|null} nodeVersion
 * @property {string|null} bin
 * @property {import('../launcher.js').LauncherProblem} problem
 * @property {string|null} error  set when the definition exists but could not be read
 */

/**
 * @typedef {object} ServiceBackend  how the daemon is kept running on this platform
 * @property {'launchd'|'systemd'|'startup'|'background'} id
 * @property {string} label            e.g. "launchd agent"
 * @property {string|null} file        the service definition `updeps start` writes
 * @property {boolean} atLogin         whether the daemon starts again at login
 * @property {() => void | Promise<void>} start  write the definition (if any) and (re)start the daemon
 * @property {() => void | Promise<void>} stop   stop the daemon; the definition stays
 * @property {() => ServiceInspection} inspect
 */

const NOT_INSTALLED = Object.freeze({
  installed: false,
  node: null,
  nodeVersion: null,
  bin: null,
  problem: null,
  error: null
});

/** @type {ServiceBackend|undefined} */
let backend;

/**
 * The service backend for this platform: a launchd agent on macOS, a systemd
 * user service on Linux, a Startup-folder script plus the supervisor on
 * Windows. Without a systemd user session (containers, WSL without systemd,
 * other init systems) the daemon runs as a supervised background process that
 * is not started at login.
 * @returns {ServiceBackend}
 */
export function serviceBackend() {
  if (backend) return backend;
  if (process.platform === 'darwin') {
    backend = {
      id: 'launchd',
      label: 'launchd agent',
      file: LAUNCH_AGENT_PLIST,
      atLogin: true,
      start: launchd.start,
      stop: launchd.stop,
      inspect: () => launchd.inspect()
    };
  } else if (process.platform === 'win32') {
    backend = {
      id: 'startup',
      label: 'startup script',
      file: STARTUP_SCRIPT,
      atLogin: true,
      start: startup.start,
      stop: startup.stop,
      inspect: () => startup.inspect()
    };
  } else if (systemd.available()) {
    backend = {
      id: 'systemd',
      label: 'systemd unit',
      file: SYSTEMD_UNIT_FILE,
      atLogin: true,
      start: systemd.start,
      stop: systemd.stop,
      inspect: () => systemd.inspect()
    };
  } else {
    backend = {
      id: 'background',
      label: 'background process',
      file: null,
      atLogin: false,
      start: supervised.start,
      stop: supervised.stop,
      inspect: () => ({ ...NOT_INSTALLED })
    };
  }
  return backend;
}

/**
 * Validates the config, then installs and (re)starts the service, and waits
 * (up to 10s) until the daemon answers on its control channel.
 * @returns {Promise<ServiceBackend>}
 */
export async function startService() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`Config not found: ${CONFIG_FILE}\nCreate it with "updeps init".`);
  }
  // validate before we hand off to the service manager
  loadConfig();
  const service = serviceBackend();
  await service.start();
  await supervised.waitForDaemon(10_000);
  return service;
}

/**
 * Stops the daemon and waits (up to 30s) for it to exit.
 */
export async function stopService() {
  await serviceBackend().stop();
  await supervised.waitUntil(() => !runningDaemonPid(), 30_000);
}

/**
 * @returns {Promise<ServiceBackend>}
 */
export async function restartService() {
  await stopService();
  return startService();
}

/**
 * @returns {{
 *   backend: ServiceBackend,
 *   service: ServiceInspection,
 *   daemonPid: number|null,
 *   daemonStale: boolean,
 *   state: object
 * }}
 */
export function serviceStatus() {
  const service = serviceBackend();
  return {
    backend: service,
    service: service.inspect(),
    daemonPid: runningDaemonPid(),
    daemonStale: daemonCodeStale(),
    state: loadState()
  };
}
