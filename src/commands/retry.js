import { execSync } from 'node:child_process';
import { styleText } from 'node:util';
import { loadConfig } from '../config.js';
import { loadState } from '../state.js';
import { findRepo } from '../graph.js';
import { runSourceRepo } from '../runner.js';
import { logger } from '../logger.js';

/**
 * Retries failed operations.
 * If an id/name is specified in args, retries only that error.
 * Otherwise retries all recorded errors in state.
 * @param {object} args
 */
export async function commandRetry(args = {}) {
  const errorArg = args._?.[1];
  const state = loadState();
  const errors = state.errors || [];

  if (errors.length === 0) {
    console.log(styleText('yellow', 'Tekrar başlatılacak herhangi bir hatalı işlem bulunamadı.'));
    return;
  }

  let errorsToRetry = [];

  if (errorArg) {
    const matched = errors.find(e => e.id === errorArg || e.target === errorArg || e.sourceRepo === errorArg);
    if (!matched) {
      console.error(styleText('red', `Belirtilen ID veya ada sahip hatalı işlem bulunamadı: "${errorArg}"`));
      process.exit(1);
    }
    errorsToRetry = [matched];
  } else {
    errorsToRetry = [...errors];
  }

  const config = loadConfig();

  for (const errItem of errorsToRetry) {
    const sourceRepo = findRepo(config, errItem.sourceRepo);
    if (!sourceRepo) {
      logger.error(`[retry] Kaynak repo config içinde bulunamadı: "${errItem.sourceRepo}"`);
      continue;
    }

    let sha = '';
    let branch = 'main';
    try {
      sha = execSync('git rev-parse HEAD', { cwd: sourceRepo.path, encoding: 'utf8' }).trim();
      branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: sourceRepo.path, encoding: 'utf8' }).trim();
    } catch {
      sha = 'retry0';
    }

    const triggerContext = {
      trigger: 'manual',
      sha,
      branch
    };

    console.log(styleText(['bold', 'cyan'], `\n▶ [${sourceRepo.name} → ${errItem.target}] Tekrar başlatılıyor...`));

    await runSourceRepo({
      config,
      sourceRepo,
      triggerContext,
      dryRun: false,
      echo: true,
      targetFilter: errItem.target
    });
  }
}
