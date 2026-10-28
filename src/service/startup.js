import fs from 'node:fs';
import path from 'node:path';
import { STARTUP_SCRIPT } from '../paths.js';
import { BIN_PATH, launchPath, inspectLauncher } from '../launcher.js';
import * as supervised from './supervised.js';

/**
 * Escapes a value for a batch file line (`%` starts a variable reference).
 * Windows paths cannot contain `"`, and the values are always double-quoted.
 * @param {string} s
 */
const batchEscape = (s) => String(s).replace(/%/g, '%%');
const batchUnescape = (s) => s.replace(/%%/g, '%');

/**
 * Renders the Windows login script that goes into the user's Startup folder.
 * It sets the PATH saved at `updeps start` and runs `updeps daemon --detach`,
 * which starts the supervisor in the background and exits.
 * @returns {string}
 */
export function renderStartupScript() {
  return [
    '@echo off',
    'rem updeps: starts the updeps daemon in the background at login. Written by "updeps start".',
    `set "PATH=${batchEscape(launchPath())}"`,
    `node "${batchEscape(BIN_PATH)}" daemon --detach`,
    ''
  ].join('\r\n');
}

/**
 * Reads the CLI and PATH out of a script written by `renderStartupScript`.
 * @param {string} text
 * @returns {{ node: string, bin: string, path: string|null } | null} null when there is no launch line
 */
export function parseStartupScript(text) {
  const exec = /^node "([^"]*)" daemon --detach\s*$/m.exec(text);
  if (!exec) return null;
  const pathLine = /^set "PATH=([^"]*)"\s*$/m.exec(text);
  return { node: 'node', bin: batchUnescape(exec[1]), path: pathLine ? batchUnescape(pathLine[1]) : null };
}

/**
 * Writes the login script and starts the daemon now.
 */
export async function start() {
  fs.mkdirSync(path.dirname(STARTUP_SCRIPT), { recursive: true });
  fs.writeFileSync(STARTUP_SCRIPT, renderStartupScript(), 'utf8');
  await supervised.start();
}

/**
 * Stops the daemon. The login script stays, so it starts again at the next login.
 */
export function stop() {
  return supervised.stop();
}

/**
 * Inspects the installed login script.
 * @param {string} [file]
 * @returns {import('./index.js').ServiceInspection}
 */
export function inspect(file = STARTUP_SCRIPT) {
  const result = { installed: false, node: null, nodeVersion: null, bin: null, problem: null, error: null };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return result;
  }
  result.installed = true;
  const parsed = parseStartupScript(text);
  if (!parsed) return { ...result, error: 'no updeps launch line' };
  return { ...result, ...inspectLauncher({ node: parsed.node, bin: parsed.bin, pathEnv: parsed.path }) };
}
