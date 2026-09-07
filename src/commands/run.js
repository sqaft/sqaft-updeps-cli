import path from 'node:path';
import { styleText } from 'node:util';
import { loadConfig } from '../config.js';
import { setEcho } from '../logger.js';
import { runSourceRepo, notifyRunGroup } from '../runner.js';
import { git } from '../exec.js';
import { resolveHome } from '../paths.js';

/**
 * Manual trigger. Runs updates for one source repo (or all), bypassing the
 * trigger/branch filters.
 * @param {string[]} positionals   [sourceSelector?]
 * @param {{ target?: string, 'dry-run'?: boolean }} opts
 */
export async function cmdRun(positionals, opts = {}) {
  setEcho(true);
  const config = loadConfig();
  const dryRun = Boolean(opts['dry-run']);
  const selector = positionals[0];

  let sources = config.repos;
  if (selector) {
    const resolved = resolveHome(selector);
    sources = config.repos.filter(
      (r) => r.name === selector || r.path === resolved || path.basename(r.path) === selector
    );
    if (sources.length === 0) {
      console.error(styleText('red', `Kaynak repo bulunamadı: ${selector}`));
      process.exit(1);
    }
  }

  for (const sourceRepo of sources) {
    const sha = git(['rev-parse', 'HEAD'], sourceRepo.path, '');
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], sourceRepo.path, 'main');
    const tally = await runSourceRepo({
      config,
      sourceRepo,
      trigger: {
        trigger: 'manual',
        branch,
        sha,
        sourceName: sourceRepo.name,
        sourcePath: sourceRepo.path
      },
      dryRun,
      echo: true,
      targetFilter: opts.target || null
    });
    notifyRunGroup({
      notifications: config.notifications,
      title: `updeps: ${sourceRepo.name}`,
      tally
    });

    if (tally.failed > 0) process.exitCode = 1;
  }
}
