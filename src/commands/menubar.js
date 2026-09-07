import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';
import { execSync, execFile } from 'node:child_process';
import { loadState, updateState } from '../state.js';
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
 * Only displays currently running operations and failed operations.
 * If idle and no errors exist, returns empty string so SwiftBar hides the item.
 * @returns {string}
 */
export function generateMenubarOutput() {
  const state = loadState();
  const activeRuns = state.activeRuns || [];
  const errors = state.errors || [];

  // If no operations are currently running and no errors exist, return empty
  if (activeRuns.length === 0 && errors.length === 0) {
    return '';
  }

  const lines = [];

  // 1. Header Title in Menubar
  if (activeRuns.length > 0 && errors.length > 0) {
    lines.push(`🔄 ${activeRuns.length} çalışıyor · ⚠️ ${errors.length} hata`);
  } else if (activeRuns.length > 0) {
    if (activeRuns.length === 1) {
      lines.push(`🔄 ${activeRuns[0].target}`);
    } else {
      lines.push(`🔄 ${activeRuns.length} işlem çalışıyor`);
    }
  } else if (errors.length > 0) {
    if (errors.length === 1) {
      lines.push(`⚠️ ${errors[0].target} hata`);
    } else {
      lines.push(`⚠️ ${errors.length} hata`);
    }
  }

  lines.push('---');

  // 2. Currently Running Operations
  if (activeRuns.length > 0) {
    lines.push(`Çalışan İşlemler (${activeRuns.length}) | font=bold`);
    for (const run of activeRuns) {
      const timeStr = formatTimeAgo(run.startedAt);
      lines.push(`🔄 ${run.sourceRepo} → ${run.target} (${timeStr}) | bash=open param1="${run.targetPath}" terminal=false`);
    }
    lines.push('---');
  }

  // 3. Failed Operations
  if (errors.length > 0) {
    const currentFile = fileURLToPath(import.meta.url);
    const cliScript = path.resolve(path.dirname(currentFile), '../../bin/updeps.js');

    lines.push(`Hata Veren İşlemler (${errors.length}) | font=bold color=red`);
    for (const err of errors) {
      const timeStr = formatTimeAgo(err.timestamp);
      const safeMsg = (err.message || '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '-').trim();
      lines.push(`⚠️ ${err.sourceRepo} → ${err.target} · ${timeStr} | color=red font=bold`);
      lines.push(`-- ↻ Tekrar Başlat | bash="${process.execPath}" param1="${cliScript}" param2="retry" param3="${err.id}" terminal=false refresh=true`);
      lines.push(`-- Hata: ${safeMsg} | font=monospace`);
      if (err.targetPath) {
        lines.push(`-- Hedef Klasörü Aç | bash=open param1="${err.targetPath}" terminal=false`);
      }
    }
    lines.push('---');
    if (errors.length > 1) {
      lines.push(`↻ Tüm Hataları Tekrar Başlat (${errors.length}) | bash="${process.execPath}" param1="${cliScript}" param2="retry" terminal=false refresh=true`);
    } else {
      lines.push(`↻ Tekrar Başlat | bash="${process.execPath}" param1="${cliScript}" param2="retry" terminal=false refresh=true`);
    }
    lines.push(`Hataları Temizle | bash="${process.execPath}" param1="${cliScript}" param2="clear-errors" terminal=false refresh=true`);
    lines.push('---');
  }

  // 4. Quick Action
  lines.push(`Log dosyasını aç | bash=open param1="${LOG_FILE}" terminal=false`);

  return lines.join('\n');
}

export function commandClearErrors() {
  updateState(state => {
    state.errors = [];
    return state;
  });
  refreshSwiftBar();
  console.log(styleText('green', '✔ Hata geçmişi temizlendi.'));
}

export function commandMenubar(args) {
  const install = Boolean(args.install);

  if (!install) {
    const output = generateMenubarOutput();
    if (output) {
      process.stdout.write(output + '\n');
    }
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
