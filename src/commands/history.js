import { styleText } from 'node:util';
import { readEvents, parseSince } from '../journal.js';

const STATUS_STYLE = {
  committed: (s) => styleText('green', s),
  unchanged: (s) => styleText('dim', s),
  skipped: (s) => styleText('yellow', s),
  failed: (s) => styleText('red', s)
};

const STATUS_LABEL = {
  committed: 'committed',
  unchanged: 'up to date',
  skipped: 'skipped',
  failed: 'FAILED'
};

/** @param {string} iso */
function shortTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * @param {{ failed?: boolean, repo?: string, since?: string, json?: boolean, lines?: string|number }} opts
 */
export function cmdHistory(opts = {}) {
  const limit = parseInt(opts.lines ?? 50, 10) || 50;
  const sinceMs = opts.since ? parseSince(opts.since) : 0;

  const records = readEvents({
    limit: opts.json ? Infinity : limit * 4, // read extra, we filter below
    filter: (r) => {
      if (r.kind !== 'target') return false;
      if (opts.failed && r.status !== 'failed') return false;
      if (opts.repo && r.source !== opts.repo && r.target !== opts.repo) return false;
      if (sinceMs && Date.parse(r.ts) < sinceMs) return false;
      return true;
    }
  }).slice(0, limit);

  if (opts.json) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  if (records.length === 0) {
    console.log(styleText('dim', 'No records.'));
    return;
  }

  for (const r of records) {
    const st = (STATUS_STYLE[r.status] || ((s) => s))(STATUS_LABEL[r.status] || r.status);
    const time = styleText('dim', shortTime(r.ts).padEnd(11));
    const d = styleText('dim', `${Math.round((r.durationMs || 0) / 1000)}s`);
    const arrow = `${r.source} ${styleText('dim', '→')} ${r.target}`;
    const sha = r.sourceSha ? styleText('dim', ` ${r.sourceSha.slice(0, 7)}`) : '';
    console.log(`${time} ${st.padEnd(10)} ${arrow}${sha} ${d}`);
    if (r.status === 'failed') {
      console.log(`  ${styleText('red', r.message)}`);
      if (r.errorTail) {
        for (const line of r.errorTail.split('\n')) console.log(styleText('dim', `  │ ${line}`));
      }
    } else if (r.status === 'committed' && r.message) {
      console.log(styleText('dim', `  ${r.commitSha ? r.commitSha + ' ' : ''}${r.message}`));
    }
    for (const w of r.warnings || []) console.log(styleText('yellow', `  ! ${w}`));
  }

  console.log(
    styleText('dim', `\n${records.length} record(s) · more: -n · failures only: --failed · JSON: --json`)
  );
}
