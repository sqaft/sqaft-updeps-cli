import { spawn, spawnSync } from 'node:child_process';

/**
 * Quotes a single argument for safe inclusion in a POSIX shell command.
 * @param {string} arg
 * @returns {string}
 */
export function shellQuote(arg) {
  if (arg === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, `'\\''`) + "'";
}

/**
 * Kills a process group by its leader pid. Swallows ESRCH (already dead).
 * @param {number} pid
 * @param {NodeJS.Signals} signal
 */
function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
}

/**
 * Runs a shell command string in a directory with a hard timeout. The command
 * runs as the leader of its own process group (`detached: true`), so a
 * timeout kills the whole tree it spawned (e.g. npm -> node), not just the
 * top-level shell — otherwise a stuck grandchild keeps the pipes open and
 * `close` never fires, leaving the run "hung" past its timeout.
 * Resolves with { code, stdout, stderr, timedOut }; never rejects on non-zero exit.
 * @param {string} command
 * @param {object} options
 * @param {string} options.cwd
 * @param {number} options.timeoutMs
 * @param {Record<string,string>} [options.env]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean, aborted: boolean }>}
 */
export function runShell(command, { cwd, timeoutMs, env, signal }) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, ...env },
      detached: true
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
      killGroup(child.pid, 'SIGKILL');
      forceResolveAfterKill();
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      killGroup(child.pid, 'SIGKILL');
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
    const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
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
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || '').trim()}`);
  }
  return (res.stdout || '').trim();
}

/**
 * Checks whether an executable is resolvable on PATH.
 * @param {string} name
 * @returns {boolean}
 */
export function commandExists(name) {
  const res = spawnSync('command', ['-v', name], { shell: true, encoding: 'utf8' });
  return res.status === 0;
}
