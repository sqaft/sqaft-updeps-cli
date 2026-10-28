import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LAUNCH_AGENT_ID, LAUNCH_AGENT_PLIST, LOG_FILE } from '../paths.js';
import { BIN_PATH, launchPath, inspectLauncher } from '../launcher.js';
import { runningDaemonPid } from '../daemon.js';

/**
 * @param {string} s
 * @returns {string}
 */
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Renders the launchd plist XML. The agent runs `node` through `/usr/bin/env`,
 * resolved against the launch PATH when launchd starts the job.
 * @returns {string}
 */
export function renderPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LAUNCH_AGENT_ID)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>${xmlEscape(BIN_PATH)}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(LOG_FILE)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(LOG_FILE)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(launchPath())}</string>
  </dict>
</dict>
</plist>
`;
}

function launchctl(args) {
  const res = spawnSync('launchctl', args, { encoding: 'utf8' });
  return { ok: res.status === 0, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function domain() {
  return `gui/${os.userInfo().uid}`;
}

/**
 * Writes the plist and (re)loads the agent.
 */
export function start() {
  fs.mkdirSync(path.dirname(LAUNCH_AGENT_PLIST), { recursive: true });
  fs.writeFileSync(LAUNCH_AGENT_PLIST, renderPlist(), 'utf8');

  launchctl(['bootout', domain(), LAUNCH_AGENT_PLIST]); // ignore result
  const res = launchctl(['bootstrap', domain(), LAUNCH_AGENT_PLIST]);
  if (!res.ok) throw new Error(`launchctl failed: ${res.stderr.trim()}`);
}

/**
 * Boots out the agent and stops any running daemon. The plist stays in
 * ~/Library/LaunchAgents, so launchd starts the daemon again at the next login.
 */
export function stop() {
  launchctl(['bootout', domain(), LAUNCH_AGENT_PLIST]);

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
 * Inspects an installed launchd agent plist. With `/usr/bin/env` as ProgramArguments[0] the
 * Node binary is whichever `node` its EnvironmentVariables.PATH resolves to and the script is
 * ProgramArguments[2]; otherwise ProgramArguments[0] is the Node binary and [1] the script.
 * `error` is set when the plist exists but could not be read.
 * @param {string} [plistPath]
 * @returns {import('./index.js').ServiceInspection}
 */
export function inspect(plistPath = LAUNCH_AGENT_PLIST) {
  const result = { installed: false, node: null, nodeVersion: null, bin: null, problem: null, error: null };
  if (!fs.existsSync(plistPath)) return result;
  result.installed = true;

  const res = spawnSync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    result.error = (res.error?.message || res.stderr || 'plutil failed').trim();
    return result;
  }
  let launcher;
  try {
    const plist = JSON.parse(res.stdout);
    const args = plist.ProgramArguments;
    if (!Array.isArray(args)) throw new Error('not an array');
    const viaEnv = args[0] === '/usr/bin/env';
    launcher = {
      node: viaEnv ? args[1] : args[0],
      bin: viaEnv ? args[2] : args[1],
      pathEnv: plist.EnvironmentVariables?.PATH
    };
  } catch (err) {
    result.error = `invalid ProgramArguments: ${err.message}`;
    return result;
  }
  return { ...result, ...inspectLauncher(launcher) };
}
