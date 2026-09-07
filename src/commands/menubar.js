import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';
import { execSync, execFile } from 'node:child_process';
import { loadState } from '../state.js';
import { LOG_FILE } from '../paths.js';

/**
 * Returns SwiftBar plugin directory by checking defaults or standard paths.
 * @returns {string}
 */
export function getSwiftBarPluginDir() {
  try {
    const customDir = execSync('defaults read com.ameba.SwiftBar PluginDirectory', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (customDir && fs.existsSync(customDir)) {
      return customDir;
    }
  } catch {
    // defaults read failed or key not set
  }

  const dotSwiftBar = path.join(os.homedir(), '.swiftbar');
  if (fs.existsSync(dotSwiftBar)) {
    return dotSwiftBar;
  }

  const swiftBarDirs = [
    path.join(os.homedir(), 'Library/Application Support/SwiftBar/plugins'),
    path.join(os.homedir(), 'Library/Application Support/SwiftBar')
  ];

  return swiftBarDirs.find(d => fs.existsSync(d)) || dotSwiftBar;
}

/**
 * Triggers SwiftBar to immediately refresh all plugins.
 */
export function refreshSwiftBar() {
  try {
    execFile('open', ['-g', 'swiftbar://refreshallplugins'], () => {});
  } catch {
    // Ignore error if SwiftBar is not running or URL fails
  }
}

/**
 * Formats relative time (e.g. "5dk önce", "2s önce").
 * @param {number} timestamp
 * @returns {string}
 */
function formatTimeAgo(timestamp) {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return `${diffSec}sn önce`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}dk önce`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}sa önce`;
  return `${Math.floor(diffHour / 24)}g önce`;
}

/**
 * Generates SwiftBar/xbar menubar output based solely on state.json.
 */
export function generateMenubarOutput() {
  const state = loadState();
  const lines = [];

  // Calculate pending pushes
  let totalPending = 0;
  const pendingItems = [];

  for (const [repoPath, repoInfo] of Object.entries(state.repos || {})) {
    const count = repoInfo.pendingPushCount || 0;
    if (count > 0) {
      totalPending += count;
      pendingItems.push({
        name: path.basename(repoPath),
        path: repoPath,
        count,
        time: repoInfo.lastProcessedAt
      });
    }
  }

  // Header Title in Menubar
  if (totalPending > 0) {
    lines.push(`⚡ ⇡${totalPending}`);
  } else if (state.errors && state.errors.length > 0) {
    lines.push('⚠️ updeps');
  } else {
    lines.push('⚡ updeps');
  }
  lines.push('---');

  // Pending Pushes section
  if (pendingItems.length > 0) {
    lines.push(`Push bekleyen (${totalPending}) | font=bold`);
    for (const item of pendingItems) {
      const timeStr = item.time ? ` · ${formatTimeAgo(item.time)}` : '';
      lines.push(`  ${item.name} · ${item.count} commit${timeStr} | bash=open param1="${item.path}" terminal=false`);
    }
    lines.push('---');
  }

  // Last run summary
  const lastRun = state.lastRuns?.[0];
  if (lastRun) {
    lines.push(`Son çalışma: ${lastRun.sourceRepo} | font=bold`);
    const dateStr = new Date(lastRun.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    lines.push(`  ${lastRun.committed} commit, ${lastRun.unchanged} güncel, ${lastRun.failed} hata · ${dateStr}`);
    lines.push('---');
  }

  // Actions
  lines.push(`Log dosyasını aç | bash=open param1="${LOG_FILE}" terminal=false`);
  lines.push('---');

  // Daemon state
  const daemon = state.daemon || {};
  if (daemon.running) {
    lines.push(`Daemon: çalışıyor (${daemon.monitoredCount || 0} repo) | color=green`);
  } else {
    lines.push('Daemon: çalışmıyor | color=orange');
  }

  return lines.join('\n');
}

export function commandMenubar(args) {
  const install = Boolean(args.install);

  if (!install) {
    console.log(generateMenubarOutput());
    return;
  }

  // Install SwiftBar plugin
  const currentFile = fileURLToPath(import.meta.url);
  const cliScript = path.resolve(path.dirname(currentFile), '../../bin/updeps.js');

  const targetDir = getSwiftBarPluginDir();
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Ensure SwiftBar preference points to this directory
  try {
    execSync(`defaults write com.ameba.SwiftBar PluginDirectory -string "${targetDir}"`, { stdio: 'ignore' });
  } catch {}

  const pluginPath = path.join(targetDir, 'sqaft-updeps.30s.sh');
  const scriptContent = `#!/bin/bash
${process.execPath} "${cliScript}" menubar
`;

  fs.writeFileSync(pluginPath, scriptContent, { mode: 0o755 });
  console.log(styleText('green', `✔ SwiftBar eklentisi kuruldu:`));
  console.log(`  ${pluginPath}`);

  try {
    execSync('open -a SwiftBar 2>/dev/null || true');
    refreshSwiftBar();
  } catch {}

  console.log('\nSwiftBar menü çubuğunuzda aktif edildi.');
}
