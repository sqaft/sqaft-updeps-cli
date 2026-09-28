import fs from 'node:fs';
import path from 'node:path';
import { styleText } from 'node:util';
import { CONFIG_FILE, LOCKS_DIR, tildify } from '../paths.js';
import { loadConfig } from '../config.js';
import { git, commandExists } from '../exec.js';
import { defaultBranch, checkPreconditions } from '../gitops.js';
import { findCycles } from '../graph.js';
import { runningDaemonPid, daemonCodeStale } from '../daemon.js';

let problems = 0;

function ok(msg) {
  console.log(`  ${styleText('green', '✓')} ${msg}`);
}
function warn(msg) {
  console.log(`  ${styleText('yellow', '!')} ${msg}`);
}
function bad(msg) {
  problems++;
  console.log(`  ${styleText('red', '✗')} ${msg}`);
}

export function cmdDoctor() {
  console.log(styleText('bold', 'Konfigürasyon'));
  if (!fs.existsSync(CONFIG_FILE)) {
    bad(`config yok: ${tildify(CONFIG_FILE)} — "updeps init" çalıştır`);
    process.exit(1);
  }
  let config;
  try {
    config = loadConfig();
    ok(`geçerli (${config.repos.length} kaynak repo)`);
    for (const w of config.warnings) warn(w);
  } catch (err) {
    bad(err.message);
    process.exit(1);
  }

  const commandFirstTokens = new Set();

  for (const repo of config.repos) {
    console.log('');
    console.log(styleText('bold', repo.name));

    const pre = checkPreconditions(repo.path);
    if (!pre.ok) {
      bad(`${pre.reason}`);
    } else {
      ok(`git reposu: ${tildify(repo.path)}`);
      const remote = git(['remote', 'get-url', 'origin'], repo.path, '');
      if (remote) ok(`origin: ${remote}`);
      else bad('origin remote tanımlı değil');

      const def = defaultBranch(repo.path);
      const branches = repo.branches.length ? repo.branches : [def];
      ok(`izlenecek branch(ler): ${branches.join(', ')}`);

      const triggers = new Set();
      for (const pkg of repo.packages) for (const t of pkg.triggers) triggers.add(t);
      for (const branch of branches) {
        const wantRemote = triggers.has('push') || triggers.has('fetch');
        const reflog = path.join(
          repo.path,
          '.git',
          'logs',
          'refs',
          wantRemote ? `remotes/origin/${branch}` : `heads/${branch}`
        );
        if (fs.existsSync(reflog)) ok(`reflog var: ${reflog.split('/.git/')[1]}`);
        else warn(`reflog yok (henüz olay olmamış olabilir): ${reflog.split('/.git/')[1]}`);
      }
    }

    for (const pkg of repo.packages) {
      const tpre = checkPreconditions(pkg.path);
      if (!tpre.ok) bad(`hedef ${pkg.name}: ${tpre.reason}`);
      else ok(`hedef ${pkg.name}: ${tildify(pkg.path)}`);
      for (const cmd of pkg.commands) {
        const first = cmd.trim().split(/\s+/)[0];
        commandFirstTokens.add(first);
      }
    }
  }

  console.log('');
  console.log(styleText('bold', 'Komutlar (PATH)'));
  for (const token of commandFirstTokens) {
    if (commandExists(token)) ok(`${token} bulundu`);
    else bad(`${token} PATH'te yok`);
  }

  console.log('');
  console.log(styleText('bold', 'Kilitler'));
  try {
    fs.mkdirSync(LOCKS_DIR, { recursive: true });
    const stale = fs.existsSync(LOCKS_DIR) ? fs.readdirSync(LOCKS_DIR) : [];
    if (stale.length === 0) ok('aktif kilit yok');
    else warn(`${stale.length} kilit dizini var: ${stale.join(', ')}`);
  } catch (err) {
    bad(`kilit dizini yazılamıyor: ${err.message}`);
  }

  console.log('');
  console.log(styleText('bold', 'Bildirim'));
  if (commandExists('terminal-notifier')) ok('terminal-notifier');
  else if (commandExists('osascript')) ok('osascript (fallback)');
  else warn('bildirim aracı yok — bildirimler sessizce atlanır');

  console.log('');
  console.log(styleText('bold', 'Daemon'));
  const pid = runningDaemonPid();
  if (pid) {
    ok(`çalışıyor (pid ${pid})`);
    if (daemonCodeStale()) warn('kod dosyaları daemon başladıktan sonra değişti — "updeps restart"');
  } else warn('çalışmıyor — "updeps start"');

  console.log('');
  console.log(styleText('bold', 'Döngüler'));
  const cycles = findCycles(config);
  if (cycles.length === 0) ok('döngü yok');
  else for (const c of cycles) warn(c.join(' → '));

  console.log('');
  if (problems === 0) console.log(styleText('green', 'Her şey yolunda.'));
  else {
    console.log(styleText('red', `${problems} sorun bulundu.`));
    process.exit(1);
  }
}
