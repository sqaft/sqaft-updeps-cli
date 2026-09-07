import { styleText } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { agentStatus } from '../daemon.js';

/** @param {number} ts */
function ago(ts) {
  if (!ts) return 'hiç';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}sn önce`;
  if (s < 3600) return `${Math.round(s / 60)}dk önce`;
  if (s < 86400) return `${Math.round(s / 3600)}sa önce`;
  return `${Math.round(s / 86400)}g önce`;
}

/** @param {number} ms */
function dur(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}sn`;
}

function render() {
  const { agentInstalled, daemonPid, daemonStale, state } = agentStatus();
  const L = [];

  L.push(styleText('bold', 'Daemon'));
  L.push(`  launchd agent : ${agentInstalled ? styleText('green', 'kurulu') : styleText('dim', 'kurulu değil')}`);
  L.push(
    `  süreç         : ${daemonPid ? styleText('green', `çalışıyor (pid ${daemonPid})`) : styleText('yellow', 'çalışmıyor')}`
  );
  if (state.daemon?.startedAt) {
    L.push(`  başlangıç     : ${ago(state.daemon.startedAt)}`);
    L.push(`  izlenen repo  : ${state.daemon.watchedRepos}`);
  }
  if (daemonStale) {
    L.push(
      styleText('yellow', '  ⚠ kod dosyaları daemon başladıktan sonra değişti — "updeps restart" gerekli')
    );
  }
  L.push('');

  // What's running right now
  L.push(styleText('bold', 'Şu an'));
  const active = state.activeRun;
  const jobs = state.queue?.jobs || [];
  if (active) {
    const tag = active.dryRun ? styleText('dim', ' [dry-run]') : '';
    L.push(
      `  ${styleText('cyan', '▶')} ${active.source} → ${active.target}${tag}  ` +
        styleText('dim', dur(Date.now() - active.startedAt))
    );
  }
  if (jobs.length > 0) {
    L.push(styleText('dim', `  kuyrukta (${jobs.length}):`));
    for (const j of jobs.slice(0, 15)) {
      const from = j.sources?.length ? styleText('dim', ` ← ${j.sources.join(', ')}`) : '';
      L.push(`  ${styleText('dim', '·')} ${j.target}${from}`);
    }
    if (jobs.length > 15) L.push(styleText('dim', `  … +${jobs.length - 15}`));
  }
  if (!active && jobs.length === 0) {
    L.push(styleText('dim', '  boşta'));
  }
  L.push('');

  // Open failures (persist until resolved)
  const failures = state.openFailures || [];
  L.push(styleText('bold', failures.length ? styleText('red', `Açık hatalar (${failures.length})`) : 'Açık hatalar'));
  if (failures.length === 0) {
    L.push(styleText('green', '  ✓ yok'));
  } else {
    for (const f of failures.slice(0, 15)) {
      const times = f.count > 1 ? styleText('dim', ` ×${f.count}`) : '';
      L.push(`  ${styleText('red', '✗')} ${f.source} → ${f.target}${times}  ${styleText('dim', ago(f.lastSeen))}`);
      L.push(`      ${styleText('dim', f.message)}`);
    }
    L.push(styleText('dim', '  → "updeps retry --failed" ile hepsini yeniden dene · "updeps show <hedef>" detay'));
  }
  L.push('');

  // Recent run groups
  L.push(styleText('bold', 'Son çalışmalar'));
  const runs = (state.lastRuns || []).slice(0, 10);
  if (runs.length === 0) L.push(styleText('dim', '  yok'));
  for (const r of runs) {
    const bits = [`${r.committed} commit`, `${r.unchanged} güncel`];
    if (r.failed) bits.push(styleText('red', `${r.failed} hata`));
    if (r.skipped) bits.push(styleText('dim', `${r.skipped} atlandı`));
    L.push(
      `  ${ago(r.timestamp).padEnd(9)} ${r.sourceRepo} ${styleText('dim', `(${r.trigger} ${r.sha})`)} → ${bits.join(', ')}`
    );
  }

  return L.join('\n');
}

/**
 * @param {{ watch?: boolean }} opts
 */
export async function cmdStatus(opts = {}) {
  if (!opts.watch) {
    console.log(render());
    return;
  }

  process.on('SIGINT', () => {
    process.stdout.write('\x1b[?25h'); // show cursor
    process.exit(0);
  });
  process.stdout.write('\x1b[?25l'); // hide cursor
  for (;;) {
    process.stdout.write('\x1b[2J\x1b[H'); // clear + home
    console.log(styleText('dim', `updeps status --watch · ${new Date().toLocaleTimeString()} · Ctrl-C çıkış`));
    console.log('');
    console.log(render());
    await sleep(1000);
  }
}
