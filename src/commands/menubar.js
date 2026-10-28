import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { styleText } from 'node:util';
import { loadState } from '../state.js';
import { runningDaemonPid, inspectAgentPlist, inspectLauncher, launchPath, BIN_PATH } from '../daemon.js';
import { resolveHome, tildify } from '../paths.js';

/**
 * Prints SwiftBar/xbar plugin output. Reads only state.json and the agent plist — no git calls.
 * @param {{ install?: boolean }} opts
 */
export function cmdMenubar(opts = {}) {
  if (opts.install) return install();

  const state = loadState();
  const pid = runningDaemonPid();

  const lastRun = state.lastRuns[0];
  const failures = state.openFailures;
  const active = state.activeRun;
  const queued = state.queue.jobs;

  // Menu bar title line
  const inFlight = queued.length + (active ? 1 : 0); // running + waiting
  const icon = !pid ? '⏸' : active ? '↻' : failures.length ? '⚠' : '⇅';
  const badge = [
    failures.length ? ` ⚠${failures.length}` : '',
    inFlight ? ` ⧗${inFlight}` : ''
  ].join('');
  console.log(`${icon}${badge}`);
  console.log('---');

  console.log(pid ? `Daemon running (pid ${pid}) | color=green` : 'Daemon stopped | color=orange');

  const agentProblems = {
    'node-missing': 'Node not found',
    'node-too-old': 'Node too old',
    'bin-missing': 'CLI not found'
  };
  const agentProblem = agentProblems[inspectAgentPlist().problem];
  if (agentProblem) {
    console.log(
      `✗ Daemon cannot start: ${agentProblem} — click to restart | color=red ` +
        `bash="${process.execPath}" param1="${BIN_PATH}" param2="restart" terminal=true refresh=true`
    );
  }

  if (active) {
    console.log(
      `▶ ${active.source} → ${active.target}${queued.length ? ` (+${queued.length} queued)` : ''} | color=blue`
    );
  }

  if (queued.length > 0) {
    console.log(`Queued (${queued.length}) | color=gray`);
    for (const j of queued.slice(0, 10)) {
      const from = j.sources?.length ? ` ← ${j.sources.join(', ')}` : '';
      console.log(`· ${j.target}${from} | size=11 color=gray`);
    }
    if (queued.length > 10) console.log(`… +${queued.length - 10} | size=11 color=gray`);
  }

  if (lastRun) {
    const d = new Date(lastRun.timestamp).toLocaleString();
    console.log(
      `Last: ${lastRun.sourceRepo} → ${lastRun.committed} committed, ${lastRun.failed} failed | color=${lastRun.failed ? 'red' : 'gray'}`
    );
    console.log(`${d} | size=11 color=gray`);
  }

  if (failures.length > 0) {
    console.log('---');
    console.log(`Open failures (${failures.length}) | color=red`);
    for (const f of failures.slice(0, 8)) {
      const times = f.count > 1 ? ` ×${f.count}` : '';
      console.log(
        `${f.source} → ${f.target}${times}: ${f.message} | size=11 color=red ` +
          `bash="${process.execPath}" param1="${BIN_PATH}" param2="show" param3="${f.target}" terminal=true`
      );
    }
    console.log(
      `↻ Retry all | color=red bash="${process.execPath}" param1="${BIN_PATH}" param2="retry" param3="--failed" terminal=true`
    );
  }

  console.log('---');
  console.log(`Status | bash="${process.execPath}" param1="${BIN_PATH}" param2="status" terminal=true`);
  console.log(`History | bash="${process.execPath}" param1="${BIN_PATH}" param2="history" terminal=true`);
  console.log(`Logs | bash="${process.execPath}" param1="${BIN_PATH}" param2="logs" param3="-f" terminal=true`);
  console.log('Maintenance | color=gray');
  console.log(
    `--Clear data (queue + failures) | color=red terminal=true refresh=true ` +
      `bash="${process.execPath}" param1="${BIN_PATH}" param2="reset"`
  );
  console.log(`Refresh | refresh=true`);
}

/**
 * Reads a `defaults` string value, or '' if unset/unavailable.
 * @param {string} domain
 * @param {string} key
 * @returns {string}
 */
function defaultsRead(domain, key) {
  try {
    return execFileSync('defaults', ['read', domain, key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/**
 * Resolves the folder SwiftBar (or xbar) actually scans for plugins.
 * @returns {{ dir: string, source: string } | null}
 */
function resolvePluginDir() {
  const swiftbarPref = defaultsRead('com.ameba.SwiftBar', 'PluginDirectory');
  const xbarPref =
    defaultsRead('com.xbarapp.osx', 'pluginsDirectory') ||
    defaultsRead('com.xbarapp.osx', 'PluginDirectory');

  const candidates = [
    process.env.SWIFTBAR_PLUGINS_PATH && { dir: process.env.SWIFTBAR_PLUGINS_PATH, source: '$SWIFTBAR_PLUGINS_PATH' },
    swiftbarPref && { dir: swiftbarPref, source: 'SwiftBar setting' },
    xbarPref && { dir: xbarPref, source: 'xbar setting' },
    { dir: path.join(os.homedir(), '.config', 'xbar', 'plugins'), source: 'xbar default' }
  ].filter(Boolean);

  for (const c of candidates) {
    const dir = resolveHome(c.dir);
    if (fs.existsSync(dir)) return { dir, source: c.source };
  }
  return null;
}

/** Name of the plugin script `updeps menubar --install` writes. */
const PLUGIN_NAME = 'updeps.30s.sh';

/** A bash word: double-quoted (with backslash escapes) or unquoted. */
const SHELL_WORD = '"(?:[^"\\\\]|\\\\.)*"|[^\\s"]+';

/**
 * Quotes a value as a bash double-quoted word.
 * @param {string} value
 * @returns {string}
 */
function shellQuote(value) {
  return `"${value.replace(/[\\"$`]/g, '\\$&')}"`;
}

/**
 * Inverse of `shellQuote` for a bash word.
 * @param {string} word
 * @returns {string}
 */
function shellUnquote(word) {
  return word.startsWith('"') ? word.slice(1, -1).replace(/\\([\\"$`])/g, '$1') : word;
}

/**
 * Parses the `export PATH=` and `exec <node> "<bin>" menubar` lines of the installed plugin script.
 * `node` is a bare name (looked up in `path`) or, in older scripts, an absolute path.
 * @param {string} script
 * @returns {{ node: string, bin: string, path: string|null } | null}
 */
export function parsePluginScript(script) {
  const exec = new RegExp(`^exec\\s+(${SHELL_WORD})\\s+(${SHELL_WORD})\\s+menubar\\s*$`, 'm').exec(script);
  if (!exec) return null;
  const exported = new RegExp(`^export\\s+PATH=(${SHELL_WORD})\\s*$`, 'm').exec(script);
  return {
    node: shellUnquote(exec[1]),
    bin: shellUnquote(exec[2]),
    path: exported ? shellUnquote(exported[1]) : null
  };
}

/**
 * Locates the installed plugin script and inspects the Node and CLI it runs.
 * `problem` is null when the plugin is not installed or its exec line is unreadable.
 * @param {string|null} [dir] plugin folder; defaults to the folder SwiftBar/xbar scans
 * @returns {{
 *   installed: boolean,
 *   path: string|null,
 *   node: string|null,
 *   nodeVersion: string|null,
 *   bin: string|null,
 *   problem: null | 'node-missing' | 'node-too-old' | 'bin-missing' | 'different-install'
 * }}
 */
export function inspectMenubarPlugin(dir = resolvePluginDir()?.dir ?? null) {
  const result = { installed: false, path: null, node: null, nodeVersion: null, bin: null, problem: null };
  if (!dir) return result;
  const pluginPath = path.join(dir, PLUGIN_NAME);
  let script;
  try {
    script = fs.readFileSync(pluginPath, 'utf8');
  } catch {
    return result;
  }
  result.installed = true;
  result.path = pluginPath;
  const parsed = parsePluginScript(script);
  if (!parsed) return result;
  return { ...result, ...inspectLauncher({ node: parsed.node, bin: parsed.bin, pathEnv: parsed.path }) };
}

function install() {
  const swiftBarInstalled = fs.existsSync('/Applications/SwiftBar.app');
  const found = resolvePluginDir();

  let dir;
  if (found) {
    dir = found.dir;
  } else if (swiftBarInstalled) {
    // SwiftBar is installed but hasn't been pointed at a folder yet.
    dir = path.join(os.homedir(), '.swiftbar');
    fs.mkdirSync(dir, { recursive: true });
    console.log(
      styleText('yellow', `SwiftBar has no plugin folder configured. Created ${tildify(dir)}.`) +
        '\nSet it as the plugin folder in SwiftBar → Preferences → "Plugin Folder".'
    );
  } else {
    console.error(
      styleText('red', 'SwiftBar/xbar not found.') +
        '\nInstall SwiftBar (brew install --cask swiftbar), choose a plugin folder, then try again.'
    );
    process.exit(1);
  }

  const pluginPath = path.join(dir, PLUGIN_NAME);
  const script = `#!/usr/bin/env bash
# <xbar.title>updeps</xbar.title>
# <xbar.desc>Dependent repo update status</xbar.desc>
export PATH=${shellQuote(launchPath())}
exec node ${shellQuote(BIN_PATH)} menubar
`;
  fs.writeFileSync(pluginPath, script, { mode: 0o755 });

  console.log(styleText('green', `Installed: ${pluginPath}`) + styleText('dim', ` (${found ? found.source : 'new folder'})`));
  console.log(styleText('dim', 'It appears after "Refresh All" in the SwiftBar menu.'));
}
