import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LOG_FILE, SYSTEMD_UNIT_FILE, SYSTEMD_UNIT_NAME } from '../paths.js';
import { BIN_PATH, launchPath, inspectLauncher } from '../launcher.js';
import { runningDaemonPid, EXIT_ALREADY_RUNNING } from '../daemon.js';

/**
 * Quotes a value for a systemd unit file: a double-quoted word with C-style
 * escapes, `%` doubled (unit specifiers) and, in command lines, `$` doubled
 * (environment variable expansion).
 * @param {string} value
 * @param {{ command?: boolean }} [opts]
 * @returns {string}
 */
function unitQuote(value, { command = false } = {}) {
  let s = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  if (command) s = s.replace(/\$/g, '$$$$');
  return `"${s}"`;
}

/**
 * Splits a unit file value into words, the inverse of `unitQuote`.
 * @param {string} value
 * @param {{ command?: boolean }} [opts]
 * @returns {string[]}
 */
function unitWords(value, { command = false } = {}) {
  const words = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(value))) {
    const word = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2];
    const unescaped = word.replace(/%%/g, '%');
    words.push(command ? unescaped.replace(/\$\$/g, '$') : unescaped);
  }
  return words;
}

/**
 * Renders the systemd user unit. Like the launchd agent it runs `node` through
 * `/usr/bin/env` with the PATH saved at `updeps start`, and is restarted when it
 * exits, except when it found another daemon already running.
 * @returns {string}
 */
export function renderUnit() {
  const log = LOG_FILE.replace(/%/g, '%%');
  return `[Unit]
Description=updeps daemon: updates the repos that depend on a pushed package

[Service]
ExecStart=/usr/bin/env node ${unitQuote(BIN_PATH, { command: true })} daemon
Environment=${unitQuote(`PATH=${launchPath()}`)}
Restart=always
RestartSec=5
RestartPreventExitStatus=${EXIT_ALREADY_RUNNING}
KillMode=mixed
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

/**
 * Reads the Node, CLI and PATH out of a unit written by `renderUnit`.
 * @param {string} text
 * @returns {{ node: string|null, bin: string|null, path: string|null } | null} null when there is no ExecStart
 */
export function parseUnit(text) {
  const exec = /^ExecStart=(.*)$/m.exec(text);
  if (!exec) return null;
  const words = unitWords(exec[1], { command: true });
  const viaEnv = words[0] === '/usr/bin/env';
  let pathEnv = null;
  for (const line of text.matchAll(/^Environment=(.*)$/gm)) {
    for (const word of unitWords(line[1])) {
      if (word.startsWith('PATH=')) pathEnv = word.slice('PATH='.length);
    }
  }
  return {
    node: (viaEnv ? words[1] : words[0]) ?? null,
    bin: (viaEnv ? words[2] : words[1]) ?? null,
    path: pathEnv
  };
}

function systemctl(args) {
  const res = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 30_000 });
  return { ok: res.status === 0, stderr: (res.stderr || res.error?.message || '').trim() };
}

/**
 * True when a systemd user manager is reachable (not the case in most
 * containers, under WSL without systemd, or on distributions without systemd).
 * @returns {boolean}
 */
export function available() {
  return spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore', timeout: 5000 }).status === 0;
}

/**
 * Writes the unit, enables it (start at login) and (re)starts it.
 */
export function start() {
  fs.mkdirSync(path.dirname(SYSTEMD_UNIT_FILE), { recursive: true });
  fs.writeFileSync(SYSTEMD_UNIT_FILE, renderUnit(), 'utf8');
  for (const args of [['daemon-reload'], ['enable', SYSTEMD_UNIT_NAME], ['restart', SYSTEMD_UNIT_NAME]]) {
    const res = systemctl(args);
    if (!res.ok) throw new Error(`systemctl --user ${args.join(' ')} failed: ${res.stderr}`);
  }
}

/**
 * Stops the service and any daemon started by hand. The unit stays enabled,
 * so systemd starts the daemon again at the next login.
 */
export function stop() {
  systemctl(['stop', SYSTEMD_UNIT_NAME]);
  const pid = runningDaemonPid();
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

/**
 * Inspects the installed unit file.
 * @param {string} [file]
 * @returns {import('./index.js').ServiceInspection}
 */
export function inspect(file = SYSTEMD_UNIT_FILE) {
  const result = { installed: false, node: null, nodeVersion: null, bin: null, problem: null, error: null };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return result;
  }
  result.installed = true;
  const parsed = parseUnit(text);
  if (!parsed) return { ...result, error: 'no ExecStart line' };
  return { ...result, ...inspectLauncher({ node: parsed.node, bin: parsed.bin, pathEnv: parsed.path }) };
}
