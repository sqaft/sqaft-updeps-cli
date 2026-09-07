import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  STATE_DIR,
  LOG_FILE,
  LAUNCH_AGENT_ID,
  LAUNCH_AGENT_PLIST
} from './paths.js';
import { loadConfig } from './config.js';
import { updateState, loadState } from './state.js';
import { logger } from './logger.js';
import { UpdateQueue } from './queue.js';
import { ReflogWatcher } from './watcher.js';

const PID_FILE = path.join(STATE_DIR, 'daemon.pid');

/**
 * Checks if a process with given PID is alive.
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns current daemon status.
 * @returns {{ running: boolean, pid: number|null, startedAt: number|null, monitoredCount: number }}
 */
export function getDaemonStatus() {
  const state = loadState();
  let pid = state.daemon?.pid;

  if (!pid && fs.existsSync(PID_FILE)) {
    try {
      pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    } catch {
      pid = null;
    }
  }

  const alive = isProcessAlive(pid);
  if (!alive && state.daemon?.running) {
    updateState(s => {
      s.daemon.running = false;
      s.daemon.pid = null;
      return s;
    });
  }

  return {
    running: alive,
    pid: alive ? pid : null,
    startedAt: alive ? state.daemon?.startedAt : null,
    monitoredCount: state.daemon?.monitoredCount || 0
  };
}

/**
 * Runs the daemon loop in foreground.
 */
export async function runDaemonProcess() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }

  // Check if already running
  const status = getDaemonStatus();
  if (status.running && status.pid !== process.pid) {
    logger.error(`Daemon zaten çalışıyor (PID: ${status.pid}). İptal ediliyor.`);
    process.exit(1);
  }

  // Write PID
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');

  let config = loadConfig();
  const queue = new UpdateQueue(config);

  const reload = () => {
    try {
      config = loadConfig();
      queue.updateConfig(config);
      watcher.config = config;
      watcher.start();
      logger.info(`Konfigürasyon yenilendi: ${config.repos.length} repo izleniyor.`);
      updateState(s => {
        s.daemon.monitoredCount = config.repos.length;
        return s;
      });
    } catch (err) {
      logger.error(`Konfigürasyon yenileme hatası: ${err.message}`);
    }
  };

  const watcher = new ReflogWatcher(config, queue, reload);
  watcher.start();

  updateState(s => {
    s.daemon.running = true;
    s.daemon.pid = process.pid;
    s.daemon.startedAt = Date.now();
    s.daemon.monitoredCount = config.repos.length;
    s.activeRuns = [];
    return s;
  });

  logger.info(`Daemon başlatıldı (PID: ${process.pid}, İzlenen repo: ${config.repos.length})`);

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`Daemon kapatılıyor (${signal})...`);
    await watcher.stop();
    try {
      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    } catch {}

    updateState(s => {
      s.daemon.running = false;
      s.daemon.pid = null;
      s.activeRuns = [];
      return s;
    });

    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep alive
  setInterval(() => {}, 1000 * 60 * 60);
}

/**
 * Generates and returns LaunchAgent plist XML.
 * @returns {string}
 */
export function generateLaunchAgentPlist() {
  const currentFile = fileURLToPath(import.meta.url);
  const cliScript = path.resolve(path.dirname(currentFile), '../bin/updeps.js');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_ID}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${cliScript}</string>
        <string>daemon-run</string>
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
        <string>${process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'}</string>
    </dict>
</dict>
</plist>
`;
}

/**
 * Starts the daemon via launchd.
 */
export function startLaunchDaemon() {
  const plistDir = path.dirname(LAUNCH_AGENT_PLIST);
  if (!fs.existsSync(plistDir)) {
    fs.mkdirSync(plistDir, { recursive: true });
  }

  fs.writeFileSync(LAUNCH_AGENT_PLIST, generateLaunchAgentPlist(), 'utf8');

  try {
    const uid = process.getuid ? process.getuid() : 501;
    // Attempt bootstrap or load
    try {
      execSync(`launchctl bootout gui/${uid}/${LAUNCH_AGENT_ID} 2>/dev/null`, { stdio: 'ignore' });
    } catch {}

    execSync(`launchctl bootstrap gui/${uid} "${LAUNCH_AGENT_PLIST}"`, { stdio: 'inherit' });
  } catch {
    // Fallback to load
    execSync(`launchctl load -w "${LAUNCH_AGENT_PLIST}"`, { stdio: 'inherit' });
  }
}

/**
 * Stops the daemon via launchd.
 */
export function stopLaunchDaemon() {
  try {
    const uid = process.getuid ? process.getuid() : 501;
    try {
      execSync(`launchctl bootout gui/${uid}/${LAUNCH_AGENT_ID} 2>/dev/null`, { stdio: 'ignore' });
    } catch {
      execSync(`launchctl unload -w "${LAUNCH_AGENT_PLIST}" 2>/dev/null`, { stdio: 'ignore' });
    }
  } catch {}

  // Kill running process if any
  const status = getDaemonStatus();
  if (status.pid && isProcessAlive(status.pid)) {
    try {
      process.kill(status.pid, 'SIGTERM');
    } catch {}
  }
}
