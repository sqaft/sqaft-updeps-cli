import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LAUNCH_AGENT_ID,
  LAUNCH_AGENT_PLIST,
  LOG_FILE,
  LOGS_DIR,
  PID_FILE,
  STATE_DIR,
  CONFIG_FILE
} from './paths.js';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { loadState, updateState } from './state.js';
import { UpdateQueue } from './queue.js';
import { releaseHeldLocks } from './lock.js';
import { ReflogWatcher } from './watcher.js';
import { notifyRunGroup } from './runner.js';

/** Absolute path of this install's CLI entry point. */
export const BIN_PATH = fileURLToPath(new URL('../bin/updeps.js', import.meta.url));

/**
 * @returns {number|null} pid of a live daemon, or null
 */
export function runningDaemonPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (!pid) return null;
    process.kill(pid, 0); // throws if not alive
    return pid;
  } catch {
    return null;
  }
}

/**
 * The long-running daemon process. Blocks until SIGTERM/SIGINT.
 */
export async function runDaemon() {
  if (runningDaemonPid()) {
    logger.error('Daemon is already running.');
    process.exit(1);
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

  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down...`);
    await watcher.stop();
    await queue.shutdown(); // abort + await any in-flight command before releasing its lock
    releaseHeldLocks(); // don't strand an in-flight run's lock across a restart
    updateState((s) => {
      s.daemon = null;
      s.activeRun = null;
      s.queue = { pending: 0, jobs: [] };
      return s;
    });
    try {
      fs.rmSync(PID_FILE, { force: true });
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Keep the event loop alive.
  await new Promise(() => {});
}

/** PATH launchd gives a job that sets none. */
const LAUNCHD_DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * PATH the launchd agent and the menubar plugin run `node` with: the given PATH
 * (deduplicated, in order) plus the directory of the running Node binary appended
 * when it is not already on it, so a `node` is found even when started from a minimal environment.
 * @param {string} [basePath]
 * @param {string} [nodeDir]
 * @returns {string}
 */
export function launchPath(basePath = process.env.PATH, nodeDir = path.dirname(process.execPath)) {
  const entries = [];
  for (const entry of [...(basePath || '').split(':'), nodeDir]) {
    if (entry && !entries.includes(entry)) entries.push(entry);
  }
  return entries.join(':');
}

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

/**
 * Writes the plist and loads the agent.
 */
export function startAgent() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(LAUNCH_AGENT_PLIST), { recursive: true });

  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`Config not found: ${CONFIG_FILE}\nCreate it with "updeps init".`);
  }
  // validate before we hand off to launchd
  loadConfig();

  fs.writeFileSync(LAUNCH_AGENT_PLIST, renderPlist(), 'utf8');

  const uid = os.userInfo().uid;
  const domain = `gui/${uid}`;

  launchctl(['bootout', domain, LAUNCH_AGENT_PLIST]); // ignore result
  const res = launchctl(['bootstrap', domain, LAUNCH_AGENT_PLIST]);
  if (!res.ok) throw new Error(`launchctl failed: ${res.stderr.trim()}`);
  return LAUNCH_AGENT_PLIST;
}

/**
 * Boots out the agent and stops any running daemon.
 */
export function stopAgent() {
  const uid = os.userInfo().uid;
  const domain = `gui/${uid}`;
  launchctl(['bootout', domain, LAUNCH_AGENT_PLIST]);

  const pid = runningDaemonPid();
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

export function restartAgent() {
  stopAgent();
  return startAgent();
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

/**
 * Resolves symlinks; falls back to the input when the path cannot be resolved.
 * @param {string} p
 * @returns {string}
 */
function realPathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Minimum Node major version from package.json `engines.node`.
 * @returns {number}
 */
export function minNodeMajor() {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return parseInt(/\d+/.exec(pkg.engines?.node || '')?.[0] ?? '0', 10);
}

/**
 * First executable file called `name` in `pathEnv`, in PATH order (the lookup `env` does).
 * @param {string} name
 * @param {string} pathEnv
 * @returns {string|null}
 */
export function findInPath(name, pathEnv) {
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * Runs `<node> --version`.
 * @param {string} nodeBin
 * @returns {string|null} e.g. "v22.3.0", or null when it could not be determined
 */
function nodeVersionOf(nodeBin) {
  const res = spawnSync(nodeBin, ['--version'], { encoding: 'utf8', timeout: 3000 });
  const version = (res.stdout || '').trim();
  return res.status === 0 && /^v\d+\./.test(version) ? version : null;
}

/**
 * Checks what a launcher (launchd agent or menubar plugin) will run: the Node binary and the CLI entry point.
 * `node` is either a bare name, looked up in `pathEnv` the way `env` does, or an absolute path (older launchers).
 * - `node-missing`: no `node` on the PATH, or the pinned binary is gone.
 * - `node-too-old`: the resolved Node is below the minimum in package.json `engines.node`.
 * - `bin-missing`: the CLI entry point does not exist.
 * - `different-install`: the CLI entry point is not this install's `BIN_PATH` (symlinks resolved).
 * A different Node binary than the one running the CLI is not a problem.
 * @param {{ node?: string|null, bin?: string|null, pathEnv?: string|null }} launcher
 * @returns {{
 *   node: string|null,
 *   nodeVersion: string|null,
 *   bin: string|null,
 *   problem: null | 'node-missing' | 'node-too-old' | 'bin-missing' | 'different-install'
 * }}
 */
export function inspectLauncher({ node, bin, pathEnv }) {
  const result = { node: null, nodeVersion: null, bin: typeof bin === 'string' && bin ? bin : null, problem: null };

  if (typeof node === 'string' && node) {
    const pinned = node.includes('/');
    result.node = pinned ? node : findInPath(node, pathEnv || LAUNCHD_DEFAULT_PATH);
  }
  if (!result.node || !fs.existsSync(result.node)) {
    result.problem = 'node-missing';
    return result;
  }

  result.nodeVersion = nodeVersionOf(result.node);
  const major = parseInt(/^v(\d+)/.exec(result.nodeVersion || '')?.[1] ?? '', 10);
  if (major < minNodeMajor()) {
    result.problem = 'node-too-old';
  } else if (!result.bin || !fs.existsSync(result.bin)) {
    result.problem = 'bin-missing';
  } else if (realPathOr(result.bin) !== realPathOr(BIN_PATH)) {
    result.problem = 'different-install';
  }
  return result;
}

/**
 * Inspects an installed launchd agent plist. With `/usr/bin/env` as ProgramArguments[0] the
 * Node binary is whichever `node` its EnvironmentVariables.PATH resolves to and the script is
 * ProgramArguments[2]; otherwise ProgramArguments[0] is the Node binary and [1] the script.
 * `error` is set when the plist exists but could not be read.
 * @param {string} [plistPath]
 * @returns {{
 *   installed: boolean,
 *   node: string|null,
 *   nodeVersion: string|null,
 *   bin: string|null,
 *   problem: null | 'node-missing' | 'node-too-old' | 'bin-missing' | 'different-install',
 *   error: string|null
 * }}
 */
export function inspectAgentPlist(plistPath = LAUNCH_AGENT_PLIST) {
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

/**
 * @returns {{
 *   agentInstalled: boolean,
 *   agent: ReturnType<typeof inspectAgentPlist>,
 *   daemonPid: number|null,
 *   daemonStale: boolean,
 *   state: object
 * }}
 */
export function agentStatus() {
  const agent = inspectAgentPlist();
  return {
    agentInstalled: agent.installed,
    agent,
    daemonPid: runningDaemonPid(),
    daemonStale: daemonCodeStale(),
    state: loadState()
  };
}
