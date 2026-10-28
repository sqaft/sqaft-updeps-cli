import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';

/** Absolute path of this install's CLI entry point. */
export const BIN_PATH = fileURLToPath(new URL('../bin/updeps.js', import.meta.url));

/**
 * PATH a service manager gives a job that sets none: launchd's on macOS,
 * systemd's on Linux. On Windows a login script inherits the user's PATH.
 */
export const DEFAULT_SERVICE_PATH =
  process.platform === 'darwin'
    ? '/usr/bin:/bin:/usr/sbin:/sbin'
    : isWindows
      ? process.env.PATH || ''
      : '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * PATH the background service and the menubar plugin run `node` with: the given PATH
 * (deduplicated, in order) plus the directory of the running Node binary appended
 * when it is not already on it, so a `node` is found even when started from a minimal environment.
 * @param {string} [basePath]
 * @param {string} [nodeDir]
 * @returns {string}
 */
export function launchPath(basePath = process.env.PATH, nodeDir = path.dirname(process.execPath)) {
  const entries = [];
  for (const entry of [...(basePath || '').split(path.delimiter), nodeDir]) {
    if (entry && !entries.includes(entry)) entries.push(entry);
  }
  return entries.join(path.delimiter);
}

/**
 * Resolves symlinks; falls back to the input when the path cannot be resolved.
 * @param {string} p
 * @returns {string}
 */
function realPathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Minimum Node major version from package.json `engines.node`.
 * @returns {number}
 */
export function minNodeMajor() {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return parseInt(/\d+/.exec(pkg.engines?.node || '')?.[0] ?? '0', 10);
}

/**
 * First executable file called `name` in `pathEnv`, in PATH order (the lookup `env` does).
 * On Windows a name without an extension is tried with each PATHEXT extension.
 * @param {string} name
 * @param {string} pathEnv
 * @returns {string|null}
 */
export function findInPath(name, pathEnv) {
  const extensions =
    isWindows && !path.extname(name)
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (!isWindows) fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/**
 * Runs `<node> --version`.
 * @param {string} nodeBin
 * @returns {string|null} e.g. "v22.3.0", or null when it could not be determined
 */
function nodeVersionOf(nodeBin) {
  const res = spawnSync(nodeBin, ['--version'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
  const version = (res.stdout || '').trim();
  return res.status === 0 && /^v\d+\./.test(version) ? version : null;
}

/**
 * @typedef {null | 'node-missing' | 'node-too-old' | 'bin-missing' | 'different-install'} LauncherProblem
 */

/**
 * Checks what a launcher (background service or menubar plugin) will run: the Node binary and the CLI entry point.
 * `node` is either a bare name, looked up in `pathEnv` the way `env` does, or an absolute path (older launchers).
 * - `node-missing`: no `node` on the PATH, or the pinned binary is gone.
 * - `node-too-old`: the resolved Node is below the minimum in package.json `engines.node`.
 * - `bin-missing`: the CLI entry point does not exist.
 * - `different-install`: the CLI entry point is not this install's `BIN_PATH` (symlinks resolved).
 * A different Node binary than the one running the CLI is not a problem.
 * @param {{ node?: string|null, bin?: string|null, pathEnv?: string|null }} launcher
 * @returns {{ node: string|null, nodeVersion: string|null, bin: string|null, problem: LauncherProblem }}
 */
export function inspectLauncher({ node, bin, pathEnv }) {
  const result = { node: null, nodeVersion: null, bin: typeof bin === 'string' && bin ? bin : null, problem: null };

  if (typeof node === 'string' && node) {
    const pinned = path.isAbsolute(node) || node.includes('/') || node.includes('\\');
    result.node = pinned ? node : findInPath(node, pathEnv || DEFAULT_SERVICE_PATH);
  }
  if (!result.node || !fs.existsSync(result.node)) {
    result.problem = 'node-missing';
    return result;
  }

  result.nodeVersion = nodeVersionOf(result.node);
  const major = parseInt(/^v(\d+)/.exec(result.nodeVersion || '')?.[1] ?? '', 10);
  if (major < minNodeMajor()) {
    result.problem = 'node-too-old';
  } else if (!result.bin || !fs.existsSync(result.bin)) {
    result.problem = 'bin-missing';
  } else if (realPathOr(result.bin) !== realPathOr(BIN_PATH)) {
    result.problem = 'different-install';
  }
  return result;
}
