/**
 * Programmatic API for tools built on updeps, such as a desktop app or an
 * editor integration: read, check and write the config, inspect repos, read
 * the daemon's state and the run journal. Imported as `@sqaft/updeps-cli/api`.
 *
 * Everything here reads and writes the same files as the CLI and the daemon,
 * so a running daemon picks up config changes live. Actions that run updates
 * or control the daemon (`run`, `retry`, `start`, `stop`, `reset`) are not part
 * of the API: run the CLI (`BIN_PATH`) for them, so they behave exactly as on
 * the command line. Breaking changes to this API follow semver like the CLI;
 * `API_VERSION` goes up with each change a caller may need to check for.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, CONFIG_FILE, LOG_FILE, STATE_DIR, STATE_FILE, resolveHome, tildify } from './paths.js';
import {
  ConfigError,
  DEFAULT_COMMIT_PATHS,
  DEFAULT_VALUES,
  VALID_DIRTY_POLICIES,
  VALID_TRIGGERS,
  collectWarnings,
  resolveConfig,
  saveConfig,
  validateConfig
} from './config.js';
import { derivePackageNames, findCycles } from './graph.js';
import { git } from './exec.js';
import { defaultBranch } from './gitops.js';
import { loadState } from './state.js';
import { JOURNAL_FILE, readEvents, findRun, parseSince } from './journal.js';
import { redact } from './redact.js';
import { BIN_PATH } from './launcher.js';
import { runningDaemonPid, daemonCodeStale } from './daemon.js';
import { serviceBackend } from './service/index.js';

export const API_VERSION = 1;

/** Version of this install, from package.json. */
export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** Files and directories updeps uses on this machine. */
export const paths = Object.freeze({
  configDir: CONFIG_DIR,
  configFile: CONFIG_FILE,
  stateDir: STATE_DIR,
  stateFile: STATE_FILE,
  journalFile: JOURNAL_FILE,
  logFile: LOG_FILE
});

export { BIN_PATH, ConfigError, DEFAULT_COMMIT_PATHS, DEFAULT_VALUES, VALID_DIRTY_POLICIES, VALID_TRIGGERS };

/**
 * Resolves a path as the config does (`~/...` expanded, made absolute). Two
 * config entries refer to the same repo when their resolved paths are equal.
 * @param {string} p
 * @returns {string}
 */
export const resolvePath = (p) => resolveHome(p);

/**
 * Shortens an absolute path under the home directory to `~/...`, the form the
 * config is usually written in.
 * @param {string} p
 * @returns {string}
 */
export const displayPath = (p) => tildify(p);

/**
 * Reads the config file as written (`~` paths, inherited fields left out).
 * @returns {{ exists: boolean, raw: object|null, error: string|null }}
 *   `error` is set when the file exists but is not valid JSON
 */
export function readConfigFile() {
  let text;
  try {
    text = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch {
    return { exists: false, raw: null, error: null };
  }
  try {
    return { exists: true, raw: JSON.parse(text), error: null };
  } catch (err) {
    return { exists: true, raw: null, error: `not valid JSON: ${err.message}` };
  }
}

/**
 * Checks a raw config object (the shape of the config file) the way the
 * daemon will load it.
 * @param {unknown} raw
 * @returns {{
 *   ok: boolean,
 *   error: string|null,
 *   warnings: string[],
 *   config: ReturnType<typeof resolveConfig>|null,
 *   cycles: string[][],
 *   pkgs: Record<string, string[]>
 * }} `error` is the validation error, `warnings` the unknown-field warnings,
 *   `config` the resolved config (paths expanded, defaults inherited by every target),
 *   `cycles` the dependency cycles by name, `pkgs` the derived `{pkgs}` list per target path
 */
export function checkConfig(raw) {
  try {
    const config = resolveConfig(raw);
    const pkgs = {};
    for (const repo of config.repos) {
      for (const pkg of repo.packages) pkgs[pkg.path] ??= derivePackageNames(config, pkg.path);
    }
    return { ok: true, error: null, warnings: config.warnings, config, cycles: findCycles(config), pkgs };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return { ok: false, error: err.message, warnings: collectWarnings(raw), config: null, cycles: [], pkgs: {} };
  }
}

/**
 * Validates a raw config object and writes it to the config file atomically.
 * Fields the API does not know (including `_`-prefixed comments) are written
 * back as they are. A running daemon reloads it within a moment.
 * @param {object} raw
 * @throws {ConfigError} when the config is invalid; the file is left untouched
 */
export function writeConfigFile(raw) {
  validateConfig(raw);
  saveConfig(raw, CONFIG_FILE);
}

/**
 * Manifest files a package name is read from, in order.
 * @type {Array<{ file: string, name: (text: string) => string|undefined }>}
 */
const MANIFESTS = [
  { file: 'package.json', name: (t) => JSON.parse(t).name },
  { file: 'composer.json', name: (t) => JSON.parse(t).name },
  { file: 'Cargo.toml', name: (t) => /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(t)?.[1] },
  { file: 'go.mod', name: (t) => /^module\s+(\S+)/m.exec(t)?.[1] },
  { file: 'pubspec.yaml', name: (t) => /^name:\s*['"]?([\w-]+)/m.exec(t)?.[1] },
  { file: 'pyproject.toml', name: (t) => /^\[project\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(t)?.[1] }
];

/**
 * Looks at a directory the way the config refers to it, for suggesting a repo's
 * settings: whether it is a git repo, its default branch, the remote-tracking
 * branches, the `origin` URL (credentials in it masked) and the package name
 * in its manifest.
 * @param {string} dir  as in the config (`~/...` allowed)
 * @returns {{
 *   path: string,
 *   exists: boolean,
 *   isGit: boolean,
 *   defaultBranch: string|null,
 *   branches: string[],
 *   origin: string|null,
 *   packageName: string|null,
 *   manifest: string|null
 * }}
 */
export function inspectRepo(dir) {
  const abs = resolveHome(dir);
  const result = {
    path: abs,
    exists: false,
    isGit: false,
    defaultBranch: null,
    branches: [],
    origin: null,
    packageName: null,
    manifest: null
  };
  try {
    result.exists = fs.statSync(abs).isDirectory();
  } catch {
    return result;
  }
  if (!result.exists) return result;

  result.isGit = fs.existsSync(path.join(abs, '.git'));
  if (result.isGit) {
    result.defaultBranch = defaultBranch(abs) || null;
    result.branches = git(['for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/origin'], abs, '')
      .split('\n')
      .filter((b) => b && b !== 'HEAD');
    result.origin = redact(git(['remote', 'get-url', 'origin'], abs, '')) || null;
  }

  for (const { file, name } of MANIFESTS) {
    let text;
    try {
      text = fs.readFileSync(path.join(abs, file), 'utf8');
    } catch {
      continue;
    }
    try {
      const found = name(text);
      if (typeof found === 'string' && found) {
        result.packageName = found;
        result.manifest = file;
        break;
      }
    } catch {
      /* unparseable manifest — try the next one */
    }
  }
  return result;
}

/**
 * The daemon's current state, without spawning any process (cheap enough to
 * call on every change of `paths.stateFile`).
 * @returns {{
 *   daemon: { running: boolean, pid: number|null, startedAt: number|null, watchedRepos: number|null, stale: boolean },
 *   activeRun: object|null,
 *   queue: { pending: number, jobs: object[] },
 *   openFailures: object[],
 *   lastRuns: object[]
 * }}
 */
export function readStatus() {
  const state = loadState();
  const pid = runningDaemonPid();
  return {
    daemon: {
      running: pid !== null,
      pid,
      startedAt: pid ? (state.daemon?.startedAt ?? null) : null,
      watchedRepos: pid ? (state.daemon?.watchedRepos ?? null) : null,
      stale: daemonCodeStale()
    },
    activeRun: pid ? state.activeRun : null,
    queue: pid ? state.queue : { pending: 0, jobs: [] },
    openFailures: state.openFailures,
    lastRuns: state.lastRuns
  };
}

/**
 * How the daemon is installed on this machine and what the installed service
 * will run. Runs `node --version` (and on Linux `systemctl`), so call it on
 * demand rather than on every state change.
 * @returns {{
 *   id: 'launchd'|'systemd'|'startup'|'background',
 *   label: string,
 *   file: string|null,
 *   atLogin: boolean,
 *   installed: boolean,
 *   node: string|null,
 *   nodeVersion: string|null,
 *   bin: string|null,
 *   problem: import('./launcher.js').LauncherProblem,
 *   error: string|null
 * }}
 */
export function inspectService() {
  const backend = serviceBackend();
  return { id: backend.id, label: backend.label, file: backend.file, atLogin: backend.atLogin, ...backend.inspect() };
}

/**
 * Target runs from the journal, newest first.
 * @param {{ limit?: number, failed?: boolean, repo?: string, since?: string }} [opts]
 *   `repo` matches a source or target name; `since` is `30m`, `2h`, `3d`, `1w` or an ISO date
 * @returns {object[]}
 */
export function readHistory({ limit = 50, failed = false, repo, since } = {}) {
  const sinceMs = since ? parseSince(since) : 0;
  return readEvents({
    limit,
    filter: (r) =>
      r.kind === 'target' &&
      (!failed || r.status === 'failed') &&
      (!repo || r.source === repo || r.target === repo) &&
      (!sinceMs || Date.parse(r.ts) >= sinceMs)
  });
}

/**
 * One run in full, as `updeps show` prints it: by group id, or the most recent
 * run of a target or source name.
 * @param {string} selector
 * @returns {{ group: string, start: object|null, done: object|null, targets: object[] } | null}
 */
export function readRun(selector) {
  return findRun(selector);
}

/**
 * The last lines of the daemon log, with secrets masked.
 * @param {{ lines?: number }} [opts]
 * @returns {string}
 */
export function readLog({ lines = 200 } = {}) {
  let text;
  try {
    text = fs.readFileSync(LOG_FILE, 'utf8');
  } catch {
    return '';
  }
  return redact(text.split('\n').slice(-lines - 1).join('\n').trimEnd());
}
