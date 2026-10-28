import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { styleText } from 'node:util';
import { CONFIG_FILE, LAUNCH_AGENT_PLIST, LOCKS_DIR, tildify } from '../paths.js';
import { loadConfig } from '../config.js';
import { git, commandExists } from '../exec.js';
import { defaultBranch, checkPreconditions } from '../gitops.js';
import { findCycles } from '../graph.js';
import { runningDaemonPid, daemonCodeStale, inspectAgentPlist, minNodeMajor } from '../daemon.js';
import { inspectMenubarPlugin } from './menubar.js';

/** Directories where Node version managers keep their installed versions. */
const VERSION_MANAGER_DIRS = [
  '.nvm',
  '.fnm',
  path.join('Library', 'Application Support', 'fnm'),
  '.volta',
  '.asdf',
  path.join('.local', 'share', 'mise')
].map((d) => path.join(os.homedir(), d) + path.sep);

let problems = 0;

function ok(msg) {
  console.log(`  ${styleText('green', '✓')} ${msg}`);
}
function warn(msg) {
  console.log(`  ${styleText('yellow', '!')} ${msg}`);
}
function info(msg) {
  console.log(`  ${styleText('dim', 'i')} ${styleText('dim', msg)}`);
}
function bad(msg) {
  problems++;
  console.log(`  ${styleText('red', '✗')} ${msg}`);
}

/**
 * Reports one launcher (agent or menubar plugin): the Node it will run and any problem with it or the CLI.
 * @param {string} label
 * @param {ReturnType<typeof inspectAgentPlist>} launcher
 * @param {string} restartCommand command that regenerates the launcher with the current PATH
 */
function reportLauncher(label, launcher, restartCommand) {
  const fixNode = `put a supported Node first on PATH and run "${restartCommand}"`;
  const fix = `run "${restartCommand}"`;
  switch (launcher.problem) {
    case 'node-missing':
      bad(
        `${label}: ` +
          (launcher.node ? `Node binary not found: ${tildify(launcher.node)}` : '"node" not found on its PATH') +
          ` — ${fixNode}`
      );
      break;
    case 'node-too-old':
      bad(
        `${label}: Node ${launcher.nodeVersion} (${tildify(launcher.node)}) is older than the required ` +
          `v${minNodeMajor()} — ${fixNode}`
      );
      break;
    case 'bin-missing':
      bad(`${label}: CLI not found: ${tildify(launcher.bin || '(none)')} — ${fix}`);
      break;
    case 'different-install':
      warn(`${label}: runs another install (${tildify(launcher.bin)}) than this CLI — ${fix}`);
      break;
    default:
      ok(`${label}: Node: ${tildify(launcher.node)} (${launcher.nodeVersion || 'version unknown'})`);
  }
}

function checkLaunchd() {
  const agent = inspectAgentPlist();
  if (!agent.installed) {
    warn(`agent not installed: ${tildify(LAUNCH_AGENT_PLIST)} — run "updeps start"`);
  } else if (agent.error) {
    bad(`cannot read ${tildify(LAUNCH_AGENT_PLIST)}: ${agent.error} — run "updeps restart"`);
  } else {
    reportLauncher('agent', agent, 'updeps restart');
    if (agent.node && VERSION_MANAGER_DIRS.some((dir) => agent.node.startsWith(dir))) {
      info(
        'the daemon resolves "node" from the PATH saved at "updeps start"; after switching Node versions run "updeps restart"'
      );
    }
  }

  const plugin = inspectMenubarPlugin();
  if (plugin.installed) {
    if (plugin.problem || plugin.node) reportLauncher('menubar plugin', plugin, 'updeps menubar --install');
    else warn(`menubar plugin: cannot read the exec line of ${tildify(plugin.path)} — run "updeps menubar --install"`);
  }
}

export function cmdDoctor() {
  console.log(styleText('bold', 'Configuration'));
  if (!fs.existsSync(CONFIG_FILE)) {
    bad(`config not found: ${tildify(CONFIG_FILE)} — run "updeps init"`);
    process.exit(1);
  }
  let config;
  try {
    config = loadConfig();
    ok(`valid (${config.repos.length} source repos)`);
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
      ok(`git repo: ${tildify(repo.path)}`);
      const remote = git(['remote', 'get-url', 'origin'], repo.path, '');
      if (remote) ok(`origin: ${remote}`);
      else bad('no origin remote configured');

      const def = defaultBranch(repo.path);
      const branches = repo.branches.length ? repo.branches : [def];
      ok(`watched branches: ${branches.join(', ')}`);

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
        if (fs.existsSync(reflog)) ok(`reflog exists: ${reflog.split('/.git/')[1]}`);
        else warn(`no reflog (no events yet, possibly): ${reflog.split('/.git/')[1]}`);
      }
    }

    for (const pkg of repo.packages) {
      const tpre = checkPreconditions(pkg.path);
      if (!tpre.ok) bad(`target ${pkg.name}: ${tpre.reason}`);
      else ok(`target ${pkg.name}: ${tildify(pkg.path)}`);
      for (const cmd of pkg.commands) {
        const first = cmd.trim().split(/\s+/)[0];
        commandFirstTokens.add(first);
      }
    }
  }

  console.log('');
  console.log(styleText('bold', 'Commands (PATH)'));
  for (const token of commandFirstTokens) {
    if (commandExists(token)) ok(`${token} found`);
    else bad(`${token} not found in PATH`);
  }

  console.log('');
  console.log(styleText('bold', 'Locks'));
  try {
    fs.mkdirSync(LOCKS_DIR, { recursive: true });
    const stale = fs.existsSync(LOCKS_DIR) ? fs.readdirSync(LOCKS_DIR) : [];
    if (stale.length === 0) ok('no active locks');
    else warn(`${stale.length} lock directories present: ${stale.join(', ')}`);
  } catch (err) {
    bad(`lock directory is not writable: ${err.message}`);
  }

  console.log('');
  console.log(styleText('bold', 'Notifications'));
  if (commandExists('terminal-notifier')) ok('terminal-notifier');
  else if (commandExists('osascript')) ok('osascript (fallback)');
  else warn('no notification tool found — notifications are skipped silently');

  console.log('');
  console.log(styleText('bold', 'Daemon'));
  const pid = runningDaemonPid();
  if (pid) {
    ok(`running (pid ${pid})`);
    if (daemonCodeStale()) warn('code changed since the daemon started — run "updeps restart"');
  } else warn('not running — run "updeps start"');

  console.log('');
  console.log(styleText('bold', 'launchd'));
  checkLaunchd();

  console.log('');
  console.log(styleText('bold', 'Cycles'));
  const cycles = findCycles(config);
  if (cycles.length === 0) ok('no cycles');
  else for (const c of cycles) warn(c.join(' → '));

  console.log('');
  if (problems === 0) console.log(styleText('green', 'All good.'));
  else {
    console.log(styleText('red', `${problems} problem(s) found.`));
    process.exit(1);
  }
}
