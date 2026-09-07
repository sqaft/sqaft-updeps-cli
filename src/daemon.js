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
import { ReflogWatcher } from './watcher.js';
import { notifyRunGroup } from './runner.js';

const BIN_PATH = fileURLToPath(new URL('../bin/updeps.js', import.meta.url));

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
    logger.error('Daemon zaten çalışıyor.');
    process.exit(1);
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');

  let config = loadConfig();
  logger.info(`Daemon başladı (pid ${process.pid}), ${config.repos.length} kaynak repo.`);

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
      logger.info(`Konfigürasyon yeniden yüklendi: ${config.repos.length} kaynak repo.`);
    } catch (err) {
      logger.error(`Konfigürasyon yeniden yüklenemedi, eski ayarlar korunuyor: ${err.message}`);
    }
  });
  watcher.start();

  updateState((s) => {
    s.daemon = {
      pid: process.pid,
      startedAt: Date.now(),
      watchedRepos: config.repos.length
    };
    return s;
  });

  const shutdown = async (signal) => {
    logger.info(`${signal} alındı, kapanıyor...`);
    await watcher.stop();
    updateState((s) => {
      s.daemon = null;
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

/**
 * Renders the launchd plist XML.
 * @returns {string}
 */
export function renderPlist() {
  const nodeBin = process.execPath;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${BIN_PATH}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}</string>
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
    throw new Error(`Konfigürasyon yok: ${CONFIG_FILE}\n"updeps init" ile oluştur.`);
  }
  // validate before we hand off to launchd
  loadConfig();

  fs.writeFileSync(LAUNCH_AGENT_PLIST, renderPlist(), 'utf8');

  const uid = os.userInfo().uid;
  const domain = `gui/${uid}`;

  launchctl(['bootout', domain, LAUNCH_AGENT_PLIST]); // ignore result
  let res = launchctl(['bootstrap', domain, LAUNCH_AGENT_PLIST]);
  if (!res.ok) {
    // older macOS
    res = launchctl(['load', '-w', LAUNCH_AGENT_PLIST]);
    if (!res.ok) throw new Error(`launchctl başarısız: ${res.stderr.trim()}`);
  }
  return LAUNCH_AGENT_PLIST;
}

/**
 * Boots out the agent and stops any running daemon.
 */
export function stopAgent() {
  const uid = os.userInfo().uid;
  const domain = `gui/${uid}`;
  launchctl(['bootout', domain, LAUNCH_AGENT_PLIST]);
  launchctl(['unload', '-w', LAUNCH_AGENT_PLIST]);

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
 * @returns {{ agentInstalled: boolean, daemonPid: number|null, daemonStale: boolean, state: object }}
 */
export function agentStatus() {
  return {
    agentInstalled: fs.existsSync(LAUNCH_AGENT_PLIST),
    daemonPid: runningDaemonPid(),
    daemonStale: daemonCodeStale(),
    state: loadState()
  };
}
