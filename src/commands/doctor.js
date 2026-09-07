import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { styleText } from 'node:util';
import { CONFIG_FILE, LOCKS_DIR, LAUNCH_AGENT_PLIST } from '../paths.js';
import { loadConfig } from '../config.js';
import { getDaemonStatus } from '../daemon.js';

function isCommandInPath(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function commandDoctor() {
  console.log(styleText(['bold', 'cyan'], '=== @sqaft/updeps Sistem Sağlık Kontrolü (Doctor) ===\n'));
  let issuesCount = 0;

  // 1. Config Check
  if (!fs.existsSync(CONFIG_FILE)) {
    console.log(styleText('red', `✖ Konfigürasyon dosyası bulunamadı: ${CONFIG_FILE}`));
    console.log(styleText('dim', '  Çözüm: "updeps init" çalıştırın.'));
    issuesCount++;
    return;
  }

  let config;
  try {
    config = loadConfig();
    console.log(styleText('green', `✔ Konfigürasyon dosyası geçerli (${config.repos.length} kaynak repo).`));
  } catch (err) {
    console.log(styleText('red', `✖ Konfigürasyon hatası: ${err.message}`));
    issuesCount++;
    return;
  }

  // 2. Repos & Git Preconditions
  const checkedPaths = new Set();
  const allCommands = new Set();

  for (const repo of config.repos) {
    checkedPaths.add({ path: repo.path, label: `Kaynak: ${repo.name}` });
    for (const pkg of (repo.packages || [])) {
      checkedPaths.add({ path: pkg.path, label: `Hedef: ${pkg.name}` });
      for (const cmd of (pkg.commands || [])) {
        const bin = cmd.trim().split(/\s+/)[0];
        if (bin && !bin.includes('{')) {
          allCommands.add(bin);
        }
      }
    }
  }

  for (const item of checkedPaths) {
    if (!fs.existsSync(item.path)) {
      console.log(styleText('red', `✖ [${item.label}] Dizin bulunamadı: ${item.path}`));
      issuesCount++;
      continue;
    }

    const gitDir = path.join(item.path, '.git');
    if (!fs.existsSync(gitDir)) {
      console.log(styleText('red', `✖ [${item.label}] Git reposu değil: ${item.path}`));
      issuesCount++;
      continue;
    }

    // Check reflog enabled
    try {
      const logAllRefUpdates = execSync('git config core.logAllRefUpdates', {
        cwd: item.path,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();

      if (logAllRefUpdates === 'false') {
        console.log(styleText('yellow', `⚠ [${item.label}] Reflog devre dışı bırakılmış (core.logAllRefUpdates=false)`));
        issuesCount++;
      }
    } catch {
      // If config not set, git defaults to true on non-bare repos
    }

    console.log(styleText('green', `✔ [${item.label}] Git reposu doğrulandı: ${path.basename(item.path)}`));
  }

  // 3. Command Tools in PATH
  for (const bin of allCommands) {
    if (isCommandInPath(bin)) {
      console.log(styleText('green', `✔ Gerekli komut PATH üzerinde mevcut: ${bin}`));
    } else {
      console.log(styleText('red', `✖ Komut PATH üzerinde bulunamadı: ${bin}`));
      issuesCount++;
    }
  }

  // 4. Daemon & LaunchAgent
  const daemon = getDaemonStatus();
  if (daemon.running) {
    console.log(styleText('green', `✔ Daemon aktif ve çalışıyor (PID: ${daemon.pid}).`));
  } else {
    console.log(styleText('yellow', '⚠ Daemon çalışmıyor. (Tetikleyicilerin otomatik çalışması için "updeps start" önerilir)'));
  }

  if (fs.existsSync(LAUNCH_AGENT_PLIST)) {
    console.log(styleText('green', `✔ LaunchAgent plist dosyası mevcut: ${LAUNCH_AGENT_PLIST}`));
  }

  // 5. Stale Locks
  if (fs.existsSync(LOCKS_DIR)) {
    const entries = fs.readdirSync(LOCKS_DIR);
    if (entries.length > 0) {
      console.log(styleText('yellow', `⚠ Kilit dizininde ${entries.length} adet kilit dosyası var (${LOCKS_DIR})`));
    } else {
      console.log(styleText('green', '✔ Kilit dizini temiz.'));
    }
  }

  // 6. Notification Tools
  const hasTerminalNotifier = isCommandInPath('terminal-notifier');
  const hasOsascript = isCommandInPath('osascript');
  if (hasTerminalNotifier) {
    console.log(styleText('green', '✔ terminal-notifier kurulu (zengin bildirimler aktif).'));
  } else if (hasOsascript) {
    console.log(styleText('green', '✔ osascript hazır (standart bildirimler aktif).'));
  } else {
    console.log(styleText('yellow', '⚠ Masaüstü bildirim aracı bulunamadı.'));
  }

  console.log('');
  if (issuesCount === 0) {
    console.log(styleText(['bold', 'green'], '🎉 Her şey yolunda! Sistem sorunsuz çalışmaya hazır.'));
  } else {
    console.log(styleText(['bold', 'yellow'], `Toplam ${issuesCount} uyarı veya sorun tespit edildi.`));
  }
}
