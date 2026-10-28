import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, resolveHome } from './paths.js';
import { compileGlob } from './glob.js';

export const VALID_TRIGGERS = ['push', 'fetch', 'commit', 'merge'];
export const VALID_DIRTY_POLICIES = ['selective', 'skip'];

/**
 * Files an update command is expected to produce: the lockfiles and manifests
 * of common package managers, at any depth. Of the paths that change while
 * the commands run, only those matching `commitPaths` are committed.
 */
export const DEFAULT_COMMIT_PATHS = Object.freeze([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'composer.json',
  'composer.lock',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
  'Package.resolved',
  'pubspec.lock'
]);

export const DEFAULT_VALUES = {
  triggers: ['push'],
  branches: [],
  commands: ['npm update {pkgs} --no-audit --no-fund'],
  shell: null, // null = the platform default: /bin/sh on macOS and Linux, cmd.exe on Windows
  commitMessage: 'chore(deps): bump {bumps}',
  commandTimeout: 300,
  debounceMs: 3000,
  staleLockSec: 900,
  waitTimeoutSec: 0,
  dirtyPolicy: 'selective',
  commitPaths: DEFAULT_COMMIT_PATHS,
  push: false,
  coalesce: true,
  squash: true
};

class ConfigError extends Error {}

function fail(fieldPath, expectation) {
  throw new ConfigError(`Config error — ${fieldPath}: ${expectation}`);
}

function assertString(value, fieldPath, { required = false } = {}) {
  if (value === undefined) {
    if (required) fail(fieldPath, 'required field, expected a string.');
    return;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    fail(fieldPath, 'must be a non-empty string.');
  }
}

function assertStringArray(value, fieldPath) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    fail(fieldPath, 'must be an array of strings (string[]).');
  }
}

function assertPositiveNumber(value, fieldPath, { allowZero = false } = {}) {
  if (value === undefined) return;
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || (!allowZero && value === 0)) {
    fail(fieldPath, allowZero ? 'must be a number greater than or equal to 0.' : 'must be a number greater than 0.');
  }
}

function assertGlobArray(value, fieldPath) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0) {
    fail(fieldPath, 'must be an array of strings (string[]) with at least one glob pattern.');
  }
  value.forEach((pattern, i) => {
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      fail(`${fieldPath}[${i}]`, 'must be a non-empty glob pattern (string).');
    }
    try {
      compileGlob(pattern);
    } catch (err) {
      fail(`${fieldPath}[${i}]`, `invalid glob pattern "${pattern}" (${err.message}).`);
    }
  });
}

function assertBoolean(value, fieldPath) {
  if (value === undefined) return;
  if (typeof value !== 'boolean') fail(fieldPath, 'must be a boolean (true/false).');
}

function assertEnum(value, fieldPath, allowed) {
  if (value === undefined) return;
  if (!allowed.includes(value)) {
    fail(fieldPath, `must be one of: ${allowed.join(', ')}.`);
  }
}

/**
 * Validates a raw parsed config object. Throws ConfigError with a field path.
 * @param {unknown} raw
 */
export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('root', 'must be a valid JSON object.');
  }

  assertBoolean(raw.notifications, 'notifications');

  const d = raw.defaults;
  if (d !== undefined) {
    if (typeof d !== 'object' || Array.isArray(d)) fail('defaults', 'must be an object.');
    assertStringArray(d.triggers, 'defaults.triggers');
    (d.triggers || []).forEach((t, i) => assertEnum(t, `defaults.triggers[${i}]`, VALID_TRIGGERS));
    assertStringArray(d.branches, 'defaults.branches');
    assertStringArray(d.commands, 'defaults.commands');
    assertString(d.shell, 'defaults.shell');
    assertString(d.commitMessage, 'defaults.commitMessage');
    assertPositiveNumber(d.commandTimeout, 'defaults.commandTimeout');
    assertPositiveNumber(d.debounceMs, 'defaults.debounceMs', { allowZero: true });
    assertPositiveNumber(d.staleLockSec, 'defaults.staleLockSec');
    assertPositiveNumber(d.waitTimeoutSec, 'defaults.waitTimeoutSec', { allowZero: true });
    assertEnum(d.dirtyPolicy, 'defaults.dirtyPolicy', VALID_DIRTY_POLICIES);
    assertGlobArray(d.commitPaths, 'defaults.commitPaths');
    assertBoolean(d.push, 'defaults.push');
    assertBoolean(d.coalesce, 'defaults.coalesce');
    assertBoolean(d.squash, 'defaults.squash');
  }

  if (raw.repos !== undefined) {
    if (!Array.isArray(raw.repos)) fail('repos', 'must be an array.');

    raw.repos.forEach((repo, ri) => {
      const rp = `repos[${ri}]`;
      if (!repo || typeof repo !== 'object' || Array.isArray(repo)) fail(rp, 'must be an object.');
      assertString(repo.path, `${rp}.path`, { required: true });
      assertString(repo.name, `${rp}.name`);
      assertStringArray(repo.branches, `${rp}.branches`);
      assertStringArray(repo.triggers, `${rp}.triggers`);
      (repo.triggers || []).forEach((t, i) =>
        assertEnum(t, `${rp}.triggers[${i}]`, VALID_TRIGGERS)
      );

      if (repo.packages !== undefined) {
        if (!Array.isArray(repo.packages)) fail(`${rp}.packages`, 'must be an array.');
        repo.packages.forEach((pkg, pi) => {
          const pp = `${rp}.packages[${pi}]`;
          if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) fail(pp, 'must be an object.');
          assertString(pkg.path, `${pp}.path`, { required: true });
          assertString(pkg.name, `${pp}.name`);
          assertStringArray(pkg.triggers, `${pp}.triggers`);
          (pkg.triggers || []).forEach((t, i) =>
            assertEnum(t, `${pp}.triggers[${i}]`, VALID_TRIGGERS)
          );
          assertStringArray(pkg.branches, `${pp}.branches`);
          assertStringArray(pkg.commands, `${pp}.commands`);
          assertString(pkg.shell, `${pp}.shell`);
          assertString(pkg.commitMessage, `${pp}.commitMessage`);
          assertPositiveNumber(pkg.commandTimeout, `${pp}.commandTimeout`);
          assertPositiveNumber(pkg.staleLockSec, `${pp}.staleLockSec`);
          assertPositiveNumber(pkg.waitTimeoutSec, `${pp}.waitTimeoutSec`, { allowZero: true });
          assertEnum(pkg.dirtyPolicy, `${pp}.dirtyPolicy`, VALID_DIRTY_POLICIES);
          assertGlobArray(pkg.commitPaths, `${pp}.commitPaths`);
          assertBoolean(pkg.push, `${pp}.push`);
          assertBoolean(pkg.coalesce, `${pp}.coalesce`);
          assertBoolean(pkg.squash, `${pp}.squash`);
        });
      }
    });
  }
}

const KNOWN_ROOT_KEYS = new Set(['notifications', 'defaults', 'repos']);
const KNOWN_DEFAULTS_KEYS = new Set([
  'triggers',
  'branches',
  'commands',
  'shell',
  'commitMessage',
  'commandTimeout',
  'debounceMs',
  'staleLockSec',
  'waitTimeoutSec',
  'dirtyPolicy',
  'commitPaths',
  'push',
  'coalesce',
  'squash'
]);
const KNOWN_REPO_KEYS = new Set(['path', 'name', 'branches', 'triggers', 'packages']);
const KNOWN_PACKAGE_KEYS = new Set([
  'path',
  'name',
  'triggers',
  'branches',
  'commands',
  'shell',
  'commitMessage',
  'commandTimeout',
  'staleLockSec',
  'waitTimeoutSec',
  'dirtyPolicy',
  'commitPaths',
  'push',
  'coalesce',
  'squash'
]);

function unknownKeysOf(obj, known) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.keys(obj).filter((k) => !known.has(k) && !k.startsWith('_'));
}

/**
 * Collects "unknown field" warnings — a typo like `comands` (missing an `m`)
 * would otherwise silently fall back to the default with no signal that
 * anything was misspelled. Never throws; structural problems are
 * `validateConfig`'s job, not this one's.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function collectWarnings(raw) {
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return warnings;

  for (const k of unknownKeysOf(raw, KNOWN_ROOT_KEYS)) warnings.push(`unknown field: ${k}`);
  for (const k of unknownKeysOf(raw.defaults, KNOWN_DEFAULTS_KEYS)) warnings.push(`unknown field: defaults.${k}`);

  (Array.isArray(raw.repos) ? raw.repos : []).forEach((repo, ri) => {
    for (const k of unknownKeysOf(repo, KNOWN_REPO_KEYS)) warnings.push(`unknown field: repos[${ri}].${k}`);
    const packages = repo && Array.isArray(repo.packages) ? repo.packages : [];
    packages.forEach((pkg, pi) => {
      for (const k of unknownKeysOf(pkg, KNOWN_PACKAGE_KEYS)) {
        warnings.push(`unknown field: repos[${ri}].packages[${pi}].${k}`);
      }
    });
  });

  return warnings;
}

/**
 * Resolves a raw config into the internal shape: paths expanded, defaults
 * inherited down to each target package.
 * @param {object} raw
 * @returns {{ notifications: boolean, defaults: object, repos: any[], warnings: string[] }}
 */
export function resolveConfig(raw) {
  validateConfig(raw);
  const warnings = collectWarnings(raw);

  const defaults = { ...DEFAULT_VALUES, ...(raw.defaults || {}) };

  const notifications = raw.notifications !== undefined ? Boolean(raw.notifications) : true;

  const repos = (raw.repos || []).map((repo) => {
    const resolvedPath = resolveHome(repo.path);
    const repoBranches = repo.branches ? [...repo.branches] : [...defaults.branches];
    const repoTriggers = repo.triggers ? [...repo.triggers] : null;

    const packages = (repo.packages || []).map((pkg) => {
      const targetPath = resolveHome(pkg.path);
      return {
        path: targetPath,
        rawPath: pkg.path,
        name: pkg.name || path.basename(targetPath),
        triggers: pkg.triggers ? [...pkg.triggers] : repoTriggers ? [...repoTriggers] : [...defaults.triggers],
        branches: pkg.branches ? [...pkg.branches] : [...repoBranches],
        commands: pkg.commands ? [...pkg.commands] : [...defaults.commands],
        shell: pkg.shell ?? defaults.shell ?? null,
        commitMessage: pkg.commitMessage ?? defaults.commitMessage,
        commandTimeout: pkg.commandTimeout ?? defaults.commandTimeout,
        staleLockSec: pkg.staleLockSec ?? defaults.staleLockSec,
        waitTimeoutSec: pkg.waitTimeoutSec ?? defaults.waitTimeoutSec,
        dirtyPolicy: pkg.dirtyPolicy ?? defaults.dirtyPolicy,
        commitPaths: pkg.commitPaths ? [...pkg.commitPaths] : [...defaults.commitPaths],
        push: pkg.push !== undefined ? Boolean(pkg.push) : Boolean(defaults.push),
        coalesce: pkg.coalesce !== undefined ? Boolean(pkg.coalesce) : Boolean(defaults.coalesce),
        squash: pkg.squash !== undefined ? Boolean(pkg.squash) : Boolean(defaults.squash)
      };
    });

    return {
      path: resolvedPath,
      rawPath: repo.path,
      name: repo.name || path.basename(resolvedPath),
      branches: repoBranches,
      packages
    };
  });

  return { notifications, defaults, repos, warnings };
}

/**
 * Loads and resolves the config file.
 * @param {string} [filePath]
 * @returns {ReturnType<typeof resolveConfig>}
 */
export function loadConfig(filePath = CONFIG_FILE) {
  if (!fs.existsSync(filePath)) {
    throw new ConfigError(
      `Config file not found: ${filePath}\n` +
        'Run "updeps init" to create an example file.'
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Config file is not valid JSON: ${filePath}\n${err.message}`);
  }
  return resolveConfig(parsed);
}

/**
 * Writes a config object to disk atomically.
 * @param {object} config
 * @param {string} [filePath]
 */
export function saveConfig(config, filePath = CONFIG_FILE) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

export { ConfigError };
