/**
 * What an interactive command prints after it has finished: a tip about the
 * desktop app while it is not installed, and an offer to update the CLI when a
 * newer version is published and this install can update itself (see
 * `src/updates.js`). Everything goes to stderr.
 *
 * `bin/updeps.js` loads this module only for a terminal, and only after the
 * command succeeded. It imports everything the update flow needs up front:
 * `npm install -g` replaces the files on disk while this process is still
 * running, so anything imported afterwards would load the new version's code
 * into the old process.
 */
import { spawnSync } from 'node:child_process';
import { styleText } from 'node:util';
import { findApp } from './commands/gui.js';
import { runningDaemonPid } from './daemon.js';
import { loadState } from './state.js';
import { BIN_PATH } from './launcher.js';
import { confirm } from './prompt.js';
import {
  CLI_PACKAGE,
  CLI_ROOT,
  checkUpdates,
  isSnoozed,
  noticesDisabled,
  readInstalledVersion,
  snoozeVersion
} from './updates.js';

const isWindows = process.platform === 'win32';

/**
 * Whether the notices are shown after a command. They are not for the daemon,
 * for output a script or the desktop app reads (`--json`, `--watch`, `--follow`),
 * with UPDEPS_NO_NOTICES set, or unless stdin, stdout and stderr are all
 * terminals, so nothing that is not a person at a prompt ever waits for an answer.
 * @param {object} opts
 * @param {string} opts.command
 * @param {Record<string, unknown>} [opts.values]  the parsed options of the command
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {{ stdin: boolean, stdout: boolean, stderr: boolean }} [opts.tty]
 * @returns {boolean}
 */
export function noticesEnabled({
  command,
  values = {},
  env = process.env,
  tty = { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY), stderr: Boolean(process.stderr.isTTY) }
}) {
  if (!tty.stdin || !tty.stdout || !tty.stderr) return false;
  if (noticesDisabled(env)) return false;
  if (command === 'daemon') return false;
  return !(values.json || values.watch || values.follow);
}

/**
 * Whether the daemon is working or has work waiting, so that restarting it
 * would abort a run.
 * @returns {boolean}
 */
function daemonBusy() {
  const state = loadState();
  return Boolean(state.activeRun) || (state.queue?.pending ?? 0) > 0 || (state.queue?.jobs?.length ?? 0) > 0;
}

/** Everything the notices touch outside this module; tests replace parts of it. */
const defaultDeps = () => ({
  env: process.env,
  tty: undefined,
  print: (line) => process.stderr.write(line + '\n'),
  ask: (question) => confirm(question, { output: process.stderr }),
  now: () => Date.now(),
  findApp,
  checkUpdates,
  isSnoozed,
  snoozeVersion,
  installCli: () =>
    spawnSync('npm', ['install', '-g', `${CLI_PACKAGE}@latest`, '--no-audit', '--no-fund'], {
      stdio: 'inherit',
      shell: isWindows
    }),
  readInstalledVersion: () => readInstalledVersion(CLI_ROOT),
  daemonPid: runningDaemonPid,
  daemonBusy,
  restartDaemon: () => spawnSync(process.execPath, [BIN_PATH, 'restart'], { stdio: 'inherit' })
});

/**
 * Prints the notices that apply after `command` finished. Does nothing when
 * `noticesEnabled` says no.
 * @param {string} command
 * @param {Record<string, unknown>} [values]  the parsed options of the command
 * @param {Partial<ReturnType<typeof defaultDeps>>} [overrides]  for tests
 * @returns {Promise<void>}
 */
export async function afterCommand(command, values = {}, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  if (!noticesEnabled({ command, values, env: deps.env, ...(deps.tty ? { tty: deps.tty } : {}) })) return;

  if (command !== 'gui' && !deps.findApp()) {
    deps.print(
      styleText('dim', 'Tip: updeps has a desktop app with a dependency graph editor and system tray status. Install it with: updeps gui install')
    );
  }

  const { cli } = await deps.checkUpdates();
  if (!cli.update || deps.isSnoozed(cli.latest, deps.now())) return;

  deps.print(`updeps ${cli.latest} is available (installed: ${cli.current}).`);
  if (!(await deps.ask('Update now? [Y/n] '))) {
    deps.snoozeVersion(cli.latest, deps.now());
    deps.print(styleText('dim', `Update later with: ${cli.command}`));
    return;
  }
  updateCli(cli, deps);
}

/**
 * Runs the npm update, then restarts the daemon on the new code when that
 * interrupts nothing. Failures are reported, never thrown.
 * @param {{ current: string, command: string }} cli
 * @param {ReturnType<typeof defaultDeps>} deps
 */
function updateCli(cli, deps) {
  const manual = `Update manually with: ${cli.command}`;
  const res = deps.installCli();
  if (res.error || res.status !== 0) {
    const reason = res.error ? res.error.message : `npm exited with code ${res.status}`;
    deps.print(styleText('red', `Could not update updeps (${reason}).`) + ` ${manual}`);
    return;
  }

  const installed = deps.readInstalledVersion();
  if (!installed || installed === cli.current) {
    deps.print(
      styleText('yellow', `npm finished, but this updeps (${cli.current}) was not replaced; npm installed it somewhere else.`) + ` ${manual}`
    );
    return;
  }
  deps.print(styleText('green', `updeps ${installed} installed.`));

  if (!deps.daemonPid()) return;
  if (deps.daemonBusy()) {
    deps.print('Run "updeps restart" when the current update finishes.');
    return;
  }
  const restart = deps.restartDaemon();
  if (restart.error || restart.status !== 0) deps.print(styleText('yellow', 'The daemon did not restart. Run "updeps restart".'));
}
