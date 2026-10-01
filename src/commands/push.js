import path from 'node:path';
import { styleText } from 'node:util';
import { loadConfig } from '../config.js';
import { runningDaemonPid, daemonCodeStale } from '../daemon.js';
import { buildGraph, changedFileCount, discoverRepos, inspectAll, planRounds, runCascade } from '../cascade.js';
import { tildify } from '../paths.js';

function fail(message) {
  console.error(styleText('red', message));
  process.exit(1);
}

/** Prints the repos in scope and the rounds a real run would take. */
function printPlan(infos, graph) {
  console.log(styleText('bold', `Kapsam (${infos.length} repo)`));
  for (const i of infos) {
    const where = styleText('dim', tildify(i.path));
    if (i.skip) {
      console.log(`  ${styleText('dim', '–')} ${i.label}  ${styleText('yellow', `atlandı: ${i.skip}`)}  ${where}`);
    } else if (i.ahead > 0) {
      const tag = i.watched ? '' : styleText('dim', ' · daemon izlemiyor');
      const fresh = i.pendingFiles ? styleText('yellow', ` + ${i.pendingFiles} dosya commit'lenecek`) : '';
      const commits = i.ahead - (i.pendingFiles ? 1 : 0);
      console.log(
        `  ${styleText('cyan', '↑')} ${i.label}  ${commits > 0 ? `${commits} commit` : 'yeni commit'}${fresh} → ${i.remote}/${i.remoteBranch}${tag}  ${where}`
      );
    } else {
      console.log(`  ${styleText('dim', '·')} ${styleText('dim', `${i.label}  güncel  ${where}`)}`);
    }
  }
  console.log('');

  const rounds = planRounds(infos, graph);
  if (rounds.length === 0) {
    console.log('Push edilecek commit yok.');
    return;
  }
  console.log(styleText('bold', 'Tahmini turlar'));
  const label = (p) => path.basename(p);
  rounds.forEach((round, i) => {
    if (round.stuck) {
      console.log(`  ${styleText('red', '✗')} sıra belirlenemedi (bağımlılık döngüsü?): ${round.stuck.map(label).join(', ')}`);
      return;
    }
    const names = round.repos.map((r) => (r.certain ? label(r.path) : `${label(r.path)} ${styleText('dim', '(olası)')}`));
    console.log(`  Tur ${i + 1}: ${names.join(', ')}`);
  });
}

/**
 * `updeps push`: pushes the unpushed commits of the repos under the current
 * directory in dependency order, waiting for the daemon between rounds.
 * With `--commit`, every pushable repo with pending changes is committed with
 * that message first.
 * @param {{ 'dry-run'?: boolean, commit?: string }} opts
 */
export async function cmdPush(opts = {}) {
  const commitMessage = opts.commit;
  if (commitMessage !== undefined && commitMessage.trim() === '') fail('--commit için boş olmayan bir commit mesajı ver.');

  const config = loadConfig();
  const repos = discoverRepos(process.cwd());
  if (repos.length === 0) fail('Bu dizinde ve altında git reposu bulunamadı.');

  const graph = buildGraph(config);

  if (opts['dry-run']) {
    const infos = inspectAll(repos, graph);
    if (commitMessage !== undefined) {
      // forecast only: a repo with pending changes will have one more commit to push
      for (const i of infos) {
        if (i.skip) continue;
        i.pendingFiles = changedFileCount(i.path);
        if (i.pendingFiles > 0) i.ahead += 1;
      }
    }
    printPlan(infos, graph);
    return;
  }

  if (!runningDaemonPid()) fail('Daemon çalışmıyor: push edilen değişiklikler işlenmez. "updeps start" ile başlat.');
  if (daemonCodeStale()) {
    console.error(styleText('yellow', '⚠ daemon eski kodla çalışıyor — "updeps restart" önerilir.'));
  }

  const tty = Boolean(process.stdout.isTTY);
  let lastProgress = '';
  const clearLine = () => {
    if (tty) process.stdout.write('\r\x1b[K');
  };
  const log = (line) => {
    clearLine();
    console.log(line);
  };
  const progress = (text) => {
    if (tty) {
      clearLine();
      if (text) process.stdout.write(styleText('dim', text));
    } else if (text && text !== lastProgress && !text.startsWith('tamamlanıyor')) {
      console.log(styleText('dim', `  ${text}`));
    }
    lastProgress = text;
  };

  let result;
  try {
    result = await runCascade({
      config,
      repos,
      isDaemonAlive: () => runningDaemonPid() !== null,
      log,
      progress,
      commitMessage
    });
  } catch (err) {
    clearLine();
    fail(err.message);
  }
  clearLine();

  for (const s of result.skipped) {
    console.log(styleText('yellow', `atlandı: ${s.label} — ${s.skip}`));
  }

  if (result.failed.length > 0) {
    console.error(
      styleText('red', `\nDaemon ${result.failed.length} hedefi güncelleyemedi, durduruldu. Düzeltip "updeps push" ile devam et.`)
    );
    console.error(styleText('dim', '  Detay: "updeps status" · "updeps show <hedef>"'));
    process.exit(1);
  }

  const pushes = result.rounds.reduce((n, r) => n + r.pushed.length, 0);
  const commits = result.committed.length > 0 ? `${result.committed.length} repo commit'lendi, ` : '';
  console.log(
    pushes === 0
      ? 'Push edilecek commit yok.'
      : styleText('green', `✓ Tamam: ${commits}${result.rounds.length} tur, ${pushes} push.`)
  );
}
