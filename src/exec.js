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
 * Runs a shell command string in a directory with a hard timeout.
 * Resolves with { code, stdout, stderr, timedOut }; never rejects on non-zero exit.
 * @param {string} command
 * @param {object} options
 * @param {string} options.cwd
 * @param {number} options.timeoutMs
 * @param {Record<string,string>} [options.env]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function runShell(command, { cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, ...env }
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err.message), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
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
    throw new Error(`git ${args.join(' ')} başarısız: ${(res.stderr || '').trim()}`);
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
