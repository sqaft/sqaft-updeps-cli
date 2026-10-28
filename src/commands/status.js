import { styleText } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { serviceStatus } from '../service/index.js';
import { minNodeMajor } from '../launcher.js';
import { tildify } from '../paths.js';

/** @param {number} ts */
function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** @param {number} ms */
function dur(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Warning for a service whose Node or CLI is missing, too old, or belongs to another install.
 * @param {import('../service/index.js').ServiceBackend} backend
 * @param {import('../service/index.js').ServiceInspection} service
 * @returns {string|null}
 */
export function serviceProblemLine(backend, service) {
  switch (service.problem) {
    case 'node-missing':
      return styleText(
        'red',
        '  ✗ the daemon cannot start: ' +
          (service.node ? `Node binary not found: ${tildify(service.node)}` : '"node" not found on its PATH') +
          ' — put a supported Node first on PATH and run "updeps restart"'
      );
    case 'node-too-old':
      return styleText(
        'red',
        `  ✗ the daemon cannot run: Node ${service.nodeVersion} (${tildify(service.node)}) is older than the required ` +
          `v${minNodeMajor()} — put a supported Node first on PATH and run "updeps restart"`
      );
    case 'bin-missing':
      return styleText(
        'red',
        `  ✗ the daemon cannot start: CLI not found: ${tildify(service.bin || '')} — run "updeps restart"`
      );
    case 'different-install':
      return styleText(
        'yellow',
        `  ⚠ the ${backend.label} runs another install (${tildify(service.bin)}) — run "updeps restart" to use this one`
      );
    default:
      return null;
  }
}

function render() {
  const { backend, service, daemonPid, daemonStale, state } = serviceStatus();
  const L = [];

  L.push(styleText('bold', 'Daemon'));
  if (backend.file) {
    L.push(
      `  ${backend.label.padEnd(14)}: ${service.installed ? styleText('green', 'installed') : styleText('dim', 'not installed')}`
    );
  } else {
    L.push(`  service       : ${styleText('dim', 'none (background process, not started at login)')}`);
  }
  L.push(
    `  process       : ${daemonPid ? styleText('green', `running (pid ${daemonPid})`) : styleText('yellow', 'not running')}`
  );
  if (state.daemon?.startedAt) {
    L.push(`  started       : ${ago(state.daemon.startedAt)}`);
    L.push(`  watched repos : ${state.daemon.watchedRepos}`);
  }
  if (daemonStale) {
    L.push(
      styleText('yellow', '  ⚠ code changed since the daemon started — run "updeps restart"')
    );
  }
  const problemLine = serviceProblemLine(backend, service);
  if (problemLine) L.push(problemLine);
  L.push('');

  // What's running right now
  L.push(styleText('bold', 'Now'));
  const active = state.activeRun;
  const jobs = state.queue.jobs;
  if (active) {
    const tag = active.dryRun ? styleText('dim', ' [dry-run]') : '';
    L.push(
      `  ${styleText('cyan', '▶')} ${active.source} → ${active.target}${tag}  ` +
        styleText('dim', dur(Date.now() - active.startedAt))
    );
  }
  if (jobs.length > 0) {
    L.push(styleText('dim', `  queued (${jobs.length}):`));
    for (const j of jobs.slice(0, 15)) {
      const from = j.sources?.length ? styleText('dim', ` ← ${j.sources.join(', ')}`) : '';
      L.push(`  ${styleText('dim', '·')} ${j.target}${from}`);
    }
    if (jobs.length > 15) L.push(styleText('dim', `  … +${jobs.length - 15}`));
  }
  if (!active && jobs.length === 0) {
    L.push(styleText('dim', '  idle'));
  }
  L.push('');

  // Open failures (persist until resolved)
  const failures = state.openFailures;
  L.push(styleText('bold', failures.length ? styleText('red', `Open failures (${failures.length})`) : 'Open failures'));
  if (failures.length === 0) {
    L.push(styleText('green', '  ✓ none'));
  } else {
    for (const f of failures.slice(0, 15)) {
      const times = f.count > 1 ? styleText('dim', ` ×${f.count}`) : '';
      L.push(`  ${styleText('red', '✗')} ${f.source} → ${f.target}${times}  ${styleText('dim', ago(f.lastSeen))}`);
      L.push(`      ${styleText('dim', f.message)}`);
    }
    L.push(styleText('dim', '  → "updeps retry --failed" retries all · "updeps show <target>" for details'));
  }
  L.push('');

  // Recent run groups
  L.push(styleText('bold', 'Recent runs'));
  const runs = state.lastRuns.slice(0, 10);
  if (runs.length === 0) L.push(styleText('dim', '  none'));
  for (const r of runs) {
    const bits = [`${r.committed} committed`, `${r.unchanged} up to date`];
    if (r.failed) bits.push(styleText('red', `${r.failed} failed`));
    if (r.skipped) bits.push(styleText('dim', `${r.skipped} skipped`));
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
    console.log(styleText('dim', `updeps status --watch · ${new Date().toLocaleTimeString()} · Ctrl-C to exit`));
    console.log('');
    console.log(render());
    await sleep(1000);
  }
}
