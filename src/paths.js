import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Expands a leading '~' / '~/' to the user's home directory, then resolves
 * the result to an absolute path.
 * @param {string} filePath
 * @returns {string}
 */
export function resolveHome(filePath) {
  if (!filePath) return filePath;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return path.resolve(filePath);
}

/**
 * Collapses a leading home-directory prefix back to '~' for display.
 * @param {string} absPath
 * @returns {string}
 */
export function tildify(absPath) {
  const home = os.homedir();
  if (absPath === home) return '~';
  if (absPath.startsWith(home + path.sep)) {
    return '~' + absPath.slice(home.length);
  }
  return absPath;
}

const homeDir = os.homedir();
const isWindows = process.platform === 'win32';

// XDG base directories when set; otherwise ~/.config, ~/.local/state and
// ~/.local/share on macOS and Linux, %APPDATA% and %LOCALAPPDATA% on Windows.
const configBase =
  process.env.XDG_CONFIG_HOME ||
  (isWindows ? process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming') : path.join(homeDir, '.config'));
const stateBase =
  process.env.XDG_STATE_HOME ||
  (isWindows ? process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local') : path.join(homeDir, '.local', 'state'));

const dataBase =
  process.env.XDG_DATA_HOME ||
  (isWindows ? process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local') : path.join(homeDir, '.local', 'share'));

export const APP_ID = 'sqaft-updeps';

export const CONFIG_DIR = path.join(configBase, APP_ID);
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export const STATE_DIR = path.join(stateBase, APP_ID);
export const STATE_FILE = path.join(STATE_DIR, 'state.json');
export const LOCKS_DIR = path.join(STATE_DIR, 'locks');
export const LOGS_DIR = path.join(STATE_DIR, 'logs');
export const LOG_FILE = path.join(LOGS_DIR, 'updeps.log');
export const PID_FILE = path.join(STATE_DIR, 'daemon.pid');
export const SUPERVISOR_PID_FILE = path.join(STATE_DIR, 'supervisor.pid');

/** Where `updeps gui install` installs the desktop app (an npm prefix of its own). */
export const DESKTOP_APP_DIR = path.join(dataBase, APP_ID, 'app');

/** Short, stable id of this state directory, so separate installs/test runs never share a socket name. */
const stateDirId = crypto.createHash('sha256').update(STATE_DIR).digest('hex').slice(0, 12);

/**
 * Address of the daemon's control channel: a named pipe on Windows, a Unix
 * domain socket elsewhere. The socket lives in the state directory unless that
 * path is too long for a socket name (about 104 bytes on macOS), in which case
 * it goes to the temp directory.
 */
export const CONTROL_ADDRESS = (() => {
  if (isWindows) return `\\\\.\\pipe\\${APP_ID}-${stateDirId}`;
  const inState = path.join(STATE_DIR, 'daemon.sock');
  return Buffer.byteLength(inState) < 100 ? inState : path.join(os.tmpdir(), `${APP_ID}-${stateDirId}.sock`);
})();

// macOS: launchd agent.
export const LAUNCH_AGENT_ID = 'com.sqaft.updeps.daemon';
export const LAUNCH_AGENT_PLIST = path.join(
  homeDir,
  'Library',
  'LaunchAgents',
  `${LAUNCH_AGENT_ID}.plist`
);

// Linux: systemd user service.
export const SYSTEMD_UNIT_NAME = `${APP_ID}.service`;
export const SYSTEMD_UNIT_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config'),
  'systemd',
  'user',
  SYSTEMD_UNIT_NAME
);

// Windows: script in the user's Startup folder.
export const STARTUP_SCRIPT = path.join(
  process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'),
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup',
  `${APP_ID}.cmd`
);

export { homeDir };
