import { execSync } from 'node:child_process';
import { styleText } from 'node:util';
import { loadConfig } from '../config.js';
import { findRepo } from '../graph.js';
import { runSourceRepo } from '../runner.js';

export async function commandRun(args) {
  const sourceArg = args._?.[1];
  const dryRun = Boolean(args['dry-run']);
  const config = loadConfig();

  if (dryRun) {
    console.log(styleText(['yellow', 'bold'], '=== DRY-RUN MODU: Değişiklikler commit veya push edilmeyecektir ===\n'));
  }

  let reposToRun = [];

  if (sourceArg) {
    const repo = findRepo(config, sourceArg);
    if (!repo) {
      console.error(styleText('red', `Kaynak repo bulunamadı: "${sourceArg}"`));
      process.exit(1);
    }
    reposToRun = [repo];
  } else {
    reposToRun = config.repos || [];
  }

  if (reposToRun.length === 0) {
    console.log(styleText('yellow', 'Çalıştırılacak kayıtlı repo bulunamadı.'));
    return;
  }

  for (const sourceRepo of reposToRun) {
    console.log(styleText(['bold', 'cyan'], `\n▶ [${sourceRepo.name}] Tetikleniyor...`));

    // Get current HEAD sha and branch from source repo
    let sha = '';
    let branch = 'main';
    try {
      sha = execSync('git rev-parse HEAD', { cwd: sourceRepo.path, encoding: 'utf8' }).trim();
      branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: sourceRepo.path, encoding: 'utf8' }).trim();
    } catch {
      sha = 'manual0';
    }

    const triggerContext = {
      trigger: 'manual',
      sha,
      branch
    };

    const res = await runSourceRepo({
      config,
      sourceRepo,
      triggerContext,
      dryRun,
      echo: true,
      targetFilter: args.target || args.t
    });

    console.log(
      styleText('bold', `\nSonuç: `) +
      styleText('green', `${res.committed} commit`) + ', ' +
      styleText('blue', `${res.unchanged} güncel`) + ', ' +
      (res.failed > 0 ? styleText('red', `${res.failed} hata`) : '0 hata') + ', ' +
      styleText('dim', `${res.skipped} atlandı`)
    );
  }
}
