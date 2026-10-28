import { styleText } from 'node:util';
import { findRun } from '../journal.js';

/**
 * Shows the full detail of one run: by group id, or the most recent run of a
 * target/source name.
 * @param {string[]} positionals  [selector]
 */
export function cmdShow(positionals) {
  const selector = positionals[0];
  if (!selector) {
    console.error('Usage: updeps show <group-id | target-name | source-name>');
    process.exit(1);
  }

  const run = findRun(selector);
  if (!run) {
    console.error(styleText('red', `No record found: ${selector}`));
    process.exit(1);
  }
  const { group: groupId, start, targets, done: doneEvt } = run;

  console.log(styleText('bold', `Run ${groupId}`));
  if (start) {
    console.log(
      `  source : ${start.source} ${styleText('dim', `(${start.trigger}${start.sha ? ' ' + start.sha.slice(0, 7) : ''})`)}`
    );
    console.log(`  time   : ${new Date(start.ts).toLocaleString()}`);
    if (start.dryRun) console.log(styleText('dim', '  (dry-run)'));
  }
  if (doneEvt) {
    console.log(
      `  result : ${doneEvt.committed} committed, ${doneEvt.unchanged} up to date, ` +
        `${doneEvt.failed} failed, ${doneEvt.skipped} skipped`
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
    console.log(`${mark} ${styleText('bold', t.target)}  ${styleText('dim', `${Math.round((t.durationMs || 0) / 1000)}s`)}`);
    for (const cmd of t.commands || []) console.log(styleText('dim', `    $ ${cmd}`));
    if (t.status === 'committed') {
      console.log(`    ${t.commitSha ? t.commitSha + ' ' : ''}${t.message}`);
      if (t.files) console.log(styleText('dim', `    files: ${t.files.join(', ')}`));
      if (t.squashed) console.log(styleText('dim', `    squashed commits: ${t.squashed.join(', ')}`));
      if (t.pushed) console.log(styleText('dim', '    pushed'));
    } else if (t.status === 'failed') {
      console.log(`    ${styleText('red', t.message)}`);
      if (t.errorTail) for (const l of t.errorTail.split('\n')) console.log(styleText('dim', `    │ ${l}`));
    } else {
      console.log(styleText('dim', `    ${t.message}`));
    }
    for (const w of t.warnings || []) console.log(styleText('yellow', `    ! ${w}`));
    console.log('');
  }
}
