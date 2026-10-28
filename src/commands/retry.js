import { styleText } from 'node:util';
import { loadConfig } from '../config.js';
import { loadState } from '../state.js';
import { setEcho } from '../logger.js';
import { git } from '../exec.js';
import { defaultBranch } from '../gitops.js';
import { runTarget, recordGroupDone, notifyRunGroup, newGroupId } from '../runner.js';
import { appendEvent } from '../journal.js';

/**
 * Re-runs failed updates. `--failed` retries every open failure; a positional
 * selector retries the open failures matching that source or target name.
 * @param {string[]} positionals
 * @param {{ failed?: boolean }} opts
 */
export async function cmdRetry(positionals, opts = {}) {
  setEcho(true);
  const config = loadConfig();
  const state = loadState();
  const selector = positionals[0];

  let failures = state.openFailures;
  if (!opts.failed && !selector) {
    console.error('Usage: updeps retry --failed   |   updeps retry <target|source>');
    process.exit(1);
  }
  if (selector) {
    failures = failures.filter((f) => f.target === selector || f.source === selector || f.id === selector);
  }

  if (failures.length === 0) {
    console.log(styleText('green', 'No open failures to retry.'));
    return;
  }

  // Resolve each failure to a (sourceRepo, target) pair from current config.
  const jobs = [];
  for (const f of failures) {
    const sourceRepo = config.repos.find((r) => r.name === f.source || r.path === f.source);
    const target = sourceRepo?.packages.find((p) => p.path === f.targetPath || p.name === f.target);
    if (!sourceRepo || !target) {
      console.log(styleText('yellow', `  skipped (not in config): ${f.source} → ${f.target}`));
      continue;
    }
    jobs.push({ sourceRepo, target, failure: f });
  }
  if (jobs.length === 0) return;

  const groupId = newGroupId('retry');
  appendEvent({
    kind: 'group_start',
    group: groupId,
    source: 'retry',
    trigger: 'manual',
    targetCount: jobs.length
  });

  console.log(styleText('bold', `Retrying ${jobs.length} failure(s)...`));
  const results = [];
  for (const { sourceRepo, target } of jobs) {
    const sha = git(['rev-parse', 'HEAD'], sourceRepo.path, '');
    const branch = defaultBranch(sourceRepo.path);
    const res = await runTarget({
      config,
      target,
      group: groupId,
      trigger: {
        trigger: 'manual',
        branch,
        sha,
        sourceName: sourceRepo.name,
        sourcePath: sourceRepo.path
      }
    });
    results.push(res);
  }

  const tally = {
    group: groupId,
    committed: results.filter((r) => r.status === 'committed').length,
    unchanged: results.filter((r) => r.status === 'unchanged').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length
  };

  recordGroupDone({
    sourceRepo: { name: 'retry', path: '' },
    trigger: { trigger: 'manual' },
    tally
  });
  notifyRunGroup({ notifications: config.notifications, title: 'updeps: retry', tally });

  const stillFailed = tally.failed
    ? styleText('red', `${tally.failed} failed`)
    : `${tally.failed} failed`;
  console.log(
    `\n${tally.committed} committed, ${tally.unchanged} up to date, ${stillFailed}, ${tally.skipped} skipped`
  );
  if (tally.failed > 0) process.exitCode = 1;
}
