import { styleText } from 'node:util';
import { agentStatus } from '../daemon.js';
import { tildify } from '../paths.js';

function ago(ts) {
  if (!ts) return 'hiç';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s önce`;
  if (s < 3600) return `${Math.round(s / 60)}dk önce`;
  if (s < 86400) return `${Math.round(s / 3600)}sa önce`;
  return `${Math.round(s / 86400)}g önce`;
}

export function cmdStatus() {
  const { agentInstalled, daemonPid, state } = agentStatus();

  console.log(styleText('bold', 'Daemon'));
  console.log(`  launchd agent : ${agentInstalled ? styleText('green', 'kurulu') : styleText('dim', 'kurulu değil')}`);
  console.log(
    `  süreç         : ${daemonPid ? styleText('green', `çalışıyor (pid ${daemonPid})`) : styleText('yellow', 'çalışmıyor')}`
  );
  if (state.daemon?.startedAt) {
    console.log(`  başlangıç     : ${ago(state.daemon.startedAt)}`);
    console.log(`  izlenen repo  : ${state.daemon.watchedRepos}`);
  }
  console.log('');

  const pending = Object.entries(state.repos || {}).filter(([, v]) => v.pendingPushCount > 0);
  console.log(styleText('bold', 'Bekleyen push'));
  if (pending.length === 0) {
    console.log(styleText('dim', '  yok'));
  } else {
    for (const [p, v] of pending) {
      console.log(`  ⇡${v.pendingPushCount}  ${tildify(p)}  ${styleText('dim', `"${v.lastCommitMessage || ''}"`)}`);
    }
  }
  console.log('');

  console.log(styleText('bold', 'Son çalışmalar'));
  const runs = (state.lastRuns || []).slice(0, 10);
  if (runs.length === 0) console.log(styleText('dim', '  yok'));
  for (const r of runs) {
    const bits = [`${r.committed} commit`, `${r.unchanged} güncel`];
    if (r.failed) bits.push(styleText('red', `${r.failed} hata`));
    if (r.skipped) bits.push(styleText('dim', `${r.skipped} atlandı`));
    console.log(`  ${ago(r.timestamp).padEnd(10)} ${r.sourceRepo} ${styleText('dim', `(${r.trigger} ${r.sha})`)} → ${bits.join(', ')}`);
  }
  console.log('');

  const errors = state.errors || [];
  if (errors.length > 0) {
    console.log(styleText('bold', styleText('red', 'Son hatalar')));
    for (const e of errors.slice(0, 10)) {
      console.log(`  ${ago(e.timestamp).padEnd(10)} ${e.sourceRepo} → ${e.target}: ${e.message}`);
    }
  }
}
