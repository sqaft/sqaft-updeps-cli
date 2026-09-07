import os from 'node:os';
import path from 'node:path';

/**
 * Expands '~' or '~/' prefix to the user's home directory.
 * @param {string} filePath
 * @returns {string}
 */
export function resolveHome(filePath) {
  if (!filePath) return filePath;
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return path.resolve(filePath);
}

const homeDir = os.homedir();
const configBase = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
const stateBase = process.env.XDG_STATE_HOME || path.join(homeDir, '.local', 'state');

export const CONFIG_DIR = path.join(configBase, 'sqaft-updeps');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export const STATE_DIR = path.join(stateBase, 'sqaft-updeps');
export const STATE_FILE = path.join(STATE_DIR, 'state.json');
export const LOCKS_DIR = path.join(STATE_DIR, 'locks');
export const LOGS_DIR = path.join(STATE_DIR, 'logs');
export const LOG_FILE = path.join(LOGS_DIR, 'updeps.log');

export const LAUNCH_AGENT_ID = 'com.sqaft.updeps.daemon';
export const LAUNCH_AGENT_PLIST = path.join(homeDir, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_ID}.plist`);
