import fs from 'node:fs';
import { styleText } from 'node:util';
import { loadConfig } from '../config.js';
import { loadState } from '../state.js';
import { getDaemonStatus } from '../daemon.js';
import { getUnpushedCount } from '../runner.js';

export function commandStatus() {
  const daemon = getDaemonStatus();
  const state = loadState();

  console.log(styleText(['bold', 'cyan'], '=== @sqaft/updeps Durum Raporu ===\n'));

  // 1. Daemon Status
  if (daemon.running) {
    const uptimeSec = daemon.startedAt ? Math.floor((Date.now() - daemon.startedAt) / 1000) : 0;
    const mins = Math.floor(uptimeSec / 60);
    const secs = uptimeSec % 60;
    console.log(
      styleText('green', '● Daemon:') +
      ` Çalışıyor (PID: ${daemon.pid}, Çalışma süresi: ${mins}dk ${secs}sn, İzlenen: ${daemon.monitoredCount} repo)`
    );
  } else {
    console.log(styleText('yellow', '○ Daemon: Kapalı (çalışmıyor)'));
    console.log(styleText('dim', '  Başlatmak için: updeps start'));
  }
  console.log('');

  // 2. Pending Pushes
  let config;
  try {
    config = loadConfig();
  } catch {
    config = null;
  }

  if (config) {
    const pendingList = [];
    const allTargets = new Set();

    for (const repo of config.repos) {
      for (const pkg of (repo.packages || [])) {
        allTargets.add(pkg.path);
      }
    }

    for (const targetPath of allTargets) {
      if (fs.existsSync(targetPath)) {
        const count = getUnpushedCount(targetPath);
        if (count > 0) {
          const repoState = state.repos[targetPath] || {};
          pendingList.push({
            path: targetPath,
            count,
            lastMessage: repoState.lastCommitMessage || ''
          });
        }
      }
    }

    console.log(styleText(['bold'], `Push Bekleyen Hedef Repolar (${pendingList.length}):`));
    if (pendingList.length === 0) {
      console.log(styleText('dim', '  Push bekleyen herhangi bir commit yok.'));
    } else {
      for (const p of pendingList) {
        console.log(`  ⇡ ${styleText('bold', p.path)}: ${styleText('yellow', `${p.count} commit`)}`);
        if (p.lastMessage) {
          console.log(styleText('dim', `     Son commit: "${p.lastMessage}"`));
        }
      }
    }
    console.log('');
  }

  // 3. Recent Runs
  const lastRuns = state.lastRuns || [];
  console.log(styleText(['bold'], `Son Çalışmalar (${lastRuns.length}):`));
  if (lastRuns.length === 0) {
    console.log(styleText('dim', '  Henüz kayıtlı bir çalışma yok.'));
  } else {
    for (const run of lastRuns.slice(0, 5)) {
      const dateStr = new Date(run.timestamp).toLocaleTimeString();
      const statusText = `${run.committed} commit, ${run.unchanged} güncel, ${run.failed} hata`;
      console.log(`  [${dateStr}] 📦 ${styleText('bold', run.sourceRepo)} (${run.trigger}) -> ${statusText}`);
    }
  }
}
