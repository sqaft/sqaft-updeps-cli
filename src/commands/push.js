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
  console.log(styleText('bold', `Scope (${infos.length} ${infos.length === 1 ? 'repo' : 'repos'})`));
  for (const i of infos) {
    const where = styleText('dim', tildify(i.path));
    if (i.skip) {
      console.log(`  ${styleText('dim', '–')} ${i.label}  ${styleText('yellow', `skipped: ${i.skip}`)}  ${where}`);
    } else if (i.ahead > 0) {
      const tag = i.watched ? '' : styleText('dim', ' · not watched by daemon');
      const fresh = i.pendingFiles ? styleText('yellow', ` + ${i.pendingFiles} ${i.pendingFiles === 1 ? 'file' : 'files'} to commit`) : '';
      const commits = i.ahead - (i.pendingFiles ? 1 : 0);
      console.log(
        `  ${styleText('cyan', '↑')} ${i.label}  ${commits > 0 ? `${commits} ${commits === 1 ? 'commit' : 'commits'}` : 'new commit'}${fresh} → ${i.remote}/${i.remoteBranch}${tag}  ${where}`
      );
    } else {
      console.log(`  ${styleText('dim', '·')} ${styleText('dim', `${i.label}  up to date  ${where}`)}`);
    }
  }
  console.log('');

  const rounds = planRounds(infos, graph);
  if (rounds.length === 0) {
    console.log('No commits to push.');
    return;
  }
  console.log(styleText('bold', 'Estimated rounds'));
  const label = (p) => path.basename(p);
  rounds.forEach((round, i) => {
    if (round.stuck) {
      console.log(`  ${styleText('red', '✗')} cannot determine order (dependency cycle?): ${round.stuck.map(label).join(', ')}`);
      return;
    }
    const names = round.repos.map((r) => (r.certain ? label(r.path) : `${label(r.path)} ${styleText('dim', '(possible)')}`));
    console.log(`  Round ${i + 1}: ${names.join(', ')}`);
  });
}

/**
 * `updeps push`: pushes the unpushed commits of the repos in scope of the
 * current directory (the enclosing repo and the repos directly below it, see
 * `discoverRepos`) in dependency order, waiting for the daemon between rounds.
 * With `--commit`, every pushable repo with pending changes is committed with
 * that message first.
 * @param {{ 'dry-run'?: boolean, commit?: string }} opts
 */
export async function cmdPush(opts = {}) {
  const commitMessage = opts.commit;
  if (commitMessage !== undefined && commitMessage.trim() === '') fail('--commit needs a non-empty commit message.');

  const config = loadConfig();
  const repos = discoverRepos(process.cwd());
  if (repos.length === 0) fail('This directory is not inside a git repository and has no git repositories directly below it.');

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

  if (!runningDaemonPid()) fail('The daemon is not running: pushed changes will not be processed. Start it with "updeps start".');
  if (daemonCodeStale()) {
    console.error(styleText('yellow', '⚠ the daemon is running outdated code — "updeps restart" is recommended.'));
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
    } else if (text && text !== lastProgress && !text.startsWith('finishing')) {
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
    console.log(styleText('yellow', `skipped: ${s.label} — ${s.skip}`));
  }

  if (result.failed.length > 0) {
    console.error(
      styleText('red', `\nThe daemon failed to update ${result.failed.length} target(s), stopped. Fix the problem and continue with "updeps push".`)
    );
    console.error(styleText('dim', '  Details: "updeps status" · "updeps show <target>"'));
    process.exit(1);
  }

  const pushes = result.rounds.reduce((n, r) => n + r.pushed.length, 0);
  const commits = result.committed.length > 0 ? `${result.committed.length} repos committed, ` : '';
  console.log(
    pushes === 0
      ? 'No commits to push.'
      : styleText('green', `✓ Done: ${commits}${result.rounds.length} rounds, ${pushes} pushes.`)
  );
}
