import { styleText } from 'node:util';
import { readEvents } from '../journal.js';

/**
 * Shows the full detail of one run: by group id, or the most recent run of a
 * target/source name.
 * @param {string[]} positionals  [selector]
 */
export function cmdShow(positionals) {
  const selector = positionals[0];
  if (!selector) {
    console.error('Kullanım: updeps show <grup-id | hedef-adı | kaynak-adı>');
    process.exit(1);
  }

  // Collect all events, then pick a group.
  const all = readEvents({ limit: 5000 });

  let groupId = selector;
  const isGroupId = all.some((r) => r.group === selector);
  if (!isGroupId) {
    // find most recent target/source match, take its group
    const match = all.find(
      (r) => r.kind === 'target' && (r.target === selector || r.source === selector)
    );
    if (!match) {
      console.error(styleText('red', `Kayıt bulunamadı: ${selector}`));
      process.exit(1);
    }
    groupId = match.group;
  }

  const events = all.filter((r) => r.group === groupId).reverse(); // chronological
  const start = events.find((r) => r.kind === 'group_start');
  const targets = events.filter((r) => r.kind === 'target');
  const doneEvt = events.find((r) => r.kind === 'group_done');

  console.log(styleText('bold', `Çalışma ${groupId}`));
  if (start) {
    console.log(
      `  kaynak   : ${start.source} ${styleText('dim', `(${start.trigger}${start.sha ? ' ' + start.sha.slice(0, 7) : ''})`)}`
    );
    console.log(`  zaman    : ${new Date(start.ts).toLocaleString()}`);
    if (start.dryRun) console.log(styleText('dim', '  (dry-run)'));
  }
  if (doneEvt) {
    console.log(
      `  sonuç    : ${doneEvt.committed} commit, ${doneEvt.unchanged} güncel, ` +
        `${doneEvt.failed} hata, ${doneEvt.skipped} atlandı`
    );
  }
  console.log('');

  for (const t of targets) {
    const mark = {
      committed: styleText('green', '✓'),
      unchanged: styleText('dim', '='),
      skipped: styleText('yellow', '~'),
      failed: styleText('red', '✗')
    }[t.status];
    console.log(`${mark} ${styleText('bold', t.target)}  ${styleText('dim', `${Math.round((t.durationMs || 0) / 1000)}sn`)}`);
    for (const cmd of t.commands || []) console.log(styleText('dim', `    $ ${cmd}`));
    if (t.status === 'committed') {
      console.log(`    ${t.commitSha ? t.commitSha + ' ' : ''}${t.message}`);
      if (t.files) console.log(styleText('dim', `    dosyalar: ${t.files.join(', ')}`));
      if (t.pushed) console.log(styleText('dim', '    push edildi'));
    } else if (t.status === 'failed') {
      console.log(`    ${styleText('red', t.message)}`);
      if (t.errorTail) for (const l of t.errorTail.split('\n')) console.log(styleText('dim', `    │ ${l}`));
    } else {
      console.log(styleText('dim', `    ${t.message}`));
    }
    console.log('');
  }
}
