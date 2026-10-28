import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

/**
 * The quoting rules a shell follows, derived from the `shell` setting: no
 * setting is the platform default (`/bin/sh` on macOS and Linux, cmd.exe on
 * Windows); otherwise the executable's name decides.
 * @param {string|null|undefined} shell
 * @returns {'posix'|'cmd'|'powershell'}
 */
export function shellKind(shell) {
  if (!shell) return isWindows ? 'cmd' : 'posix';
  const name = path.win32.basename(path.posix.basename(shell)).toLowerCase().replace(/\.exe$/, '');
  if (name === 'cmd') return 'cmd';
  if (name === 'pwsh' || name === 'powershell') return 'powershell';
  return 'posix';
}

/**
 * Quotes a single argument for safe inclusion in a command line of the given
 * shell kind (POSIX shell by default).
 * @param {string} arg
 * @param {'posix'|'cmd'|'powershell'} [kind='posix']
 * @returns {string}
 */
export function shellQuote(arg, kind = 'posix') {
  if (kind === 'cmd') {
    if (/^[A-Za-z0-9_@+=:,./\\-]+$/.test(arg)) return arg;
    return '"' + arg.replace(/"/g, '""') + '"';
  }
  if (kind === 'powershell') {
    // `@` starts a splat and `,` builds an array in PowerShell, so neither is left bare.
    if (/^[A-Za-z0-9_+=:./\\-]+$/.test(arg)) return arg;
    return "'" + arg.replace(/'/g, "''") + "'";
  }
  if (arg === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, `'\\''`) + "'";
}

/**
 * Kills a process and everything it spawned. On macOS and Linux the process
 * leads its own process group, so the group is killed; on Windows
 * `taskkill /T` walks the tree. Already-dead processes are ignored.
 * @param {number} pid
 */
function killTree(pid) {
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
}

/**
 * Runs a shell command string in a directory with a hard timeout. A timeout
 * kills the whole tree the command spawned (e.g. npm -> node), not just the
 * top-level shell — otherwise a stuck grandchild keeps the pipes open and
 * `close` never fires, leaving the run "hung" past its timeout. On macOS and
 * Linux the command leads its own process group (`detached: true`) for this;
 * on Windows the tree is killed with taskkill and no console window is opened.
 * Resolves with { code, stdout, stderr, timedOut }; never rejects on non-zero exit.
 * @param {string} command
 * @param {object} options
 * @param {string} options.cwd
 * @param {number} options.timeoutMs
 * @param {Record<string,string>} [options.env]
 * @param {AbortSignal} [options.signal]
 * @param {string|null} [options.shell]  shell executable; default: the platform default
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean, aborted: boolean }>}
 */
export function runShell(command, { cwd, timeoutMs, env, signal, shell }) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: shell || true,
      env: { ...process.env, ...env },
      detached: !isWindows,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    // Give a killed process a moment to exit before we give up on `close`
    // (e.g. an unkillable zombie) and resolve anyway.
    const forceResolveAfterKill = () => {
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ code: null, stdout, stderr, timedOut, aborted });
      }, 2000).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
      forceResolveAfterKill();
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      if (child.pid) killTree(child.pid);
      forceResolveAfterKill();
    };
    signal?.addEventListener('abort', onAbort);

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      finish({ code: null, stdout, stderr: stderr + String(err.message), timedOut, aborted });
    });
    child.on('close', (code) => {
      finish({ code, stdout, stderr, timedOut, aborted });
    });
  });
}

/**
 * Runs a git subcommand synchronously via argv (no shell). Returns trimmed
 * stdout, or a fallback string on failure.
 * @param {string[]} args
 * @param {string} cwd
 * @param {string} [fallback]
 * @returns {string}
 */
export function git(args, cwd, fallback = '') {
  try {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (res.status !== 0) return fallback;
    return (res.stdout || '').trim();
  } catch {
    return fallback;
  }
}

/**
 * Runs a git subcommand synchronously via argv, throwing on failure.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string} trimmed stdout
 */
export function gitOrThrow(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || '').trim()}`);
  }
  return (res.stdout || '').trim();
}

/**
 * Checks whether an executable is resolvable on PATH (`where` on Windows,
 * `command -v` elsewhere).
 * @param {string} name
 * @returns {boolean}
 */
export function commandExists(name) {
  if (isWindows) {
    if (path.isAbsolute(name)) return fs.existsSync(name);
    return spawnSync('where', [name], { stdio: 'ignore', windowsHide: true }).status === 0;
  }
  const res = spawnSync('command', ['-v', name], { shell: true, encoding: 'utf8' });
  return res.status === 0;
}
