import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, resolveHome } from './paths.js';

export const VALID_TRIGGERS = ['push', 'fetch', 'commit', 'merge'];
export const VALID_DIRTY_POLICIES = ['selective', 'skip'];

export const DEFAULT_VALUES = {
  triggers: ['push'],
  branches: [],
  commands: ['npm update {pkgs} --no-audit --no-fund'],
  commitMessage: 'chore(deps): bump {bumps}',
  commandTimeout: 300,
  debounceMs: 3000,
  staleLockSec: 900,
  waitTimeoutSec: 0,
  dirtyPolicy: 'selective',
  push: false,
  coalesce: true,
  squash: true
};

class ConfigError extends Error {}

function fail(fieldPath, expectation) {
  throw new ConfigError(`Konfigürasyon hatası — ${fieldPath}: ${expectation}`);
}

function assertString(value, fieldPath, { required = false } = {}) {
  if (value === undefined) {
    if (required) fail(fieldPath, 'zorunlu alan, bir metin (string) bekleniyor.');
    return;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    fail(fieldPath, 'boş olmayan bir metin (string) olmalı.');
  }
}

function assertStringArray(value, fieldPath) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    fail(fieldPath, 'bir metin dizisi (string[]) olmalı.');
  }
}

function assertPositiveNumber(value, fieldPath, { allowZero = false } = {}) {
  if (value === undefined) return;
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || (!allowZero && value === 0)) {
    fail(fieldPath, allowZero ? '0 veya daha büyük bir sayı olmalı.' : "0'dan büyük bir sayı olmalı.");
  }
}

function assertBoolean(value, fieldPath) {
  if (value === undefined) return;
  if (typeof value !== 'boolean') fail(fieldPath, 'boolean (true/false) olmalı.');
}

function assertEnum(value, fieldPath, allowed) {
  if (value === undefined) return;
  if (!allowed.includes(value)) {
    fail(fieldPath, `şu değerlerden biri olmalı: ${allowed.join(', ')}.`);
  }
}

/**
 * Validates a raw parsed config object. Throws ConfigError with a field path.
 * @param {unknown} raw
 */
export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('kök', 'geçerli bir JSON nesnesi olmalı.');
  }

  assertBoolean(raw.notifications, 'notifications');

  const d = raw.defaults;
  if (d !== undefined) {
    if (typeof d !== 'object' || Array.isArray(d)) fail('defaults', 'bir nesne olmalı.');
    assertStringArray(d.triggers, 'defaults.triggers');
    (d.triggers || []).forEach((t, i) => assertEnum(t, `defaults.triggers[${i}]`, VALID_TRIGGERS));
    assertStringArray(d.branches, 'defaults.branches');
    assertStringArray(d.commands, 'defaults.commands');
    assertString(d.commitMessage, 'defaults.commitMessage');
    assertPositiveNumber(d.commandTimeout, 'defaults.commandTimeout');
    assertPositiveNumber(d.debounceMs, 'defaults.debounceMs', { allowZero: true });
    assertPositiveNumber(d.staleLockSec, 'defaults.staleLockSec');
    assertPositiveNumber(d.waitTimeoutSec, 'defaults.waitTimeoutSec', { allowZero: true });
    assertEnum(d.dirtyPolicy, 'defaults.dirtyPolicy', VALID_DIRTY_POLICIES);
    assertBoolean(d.push, 'defaults.push');
    assertBoolean(d.coalesce, 'defaults.coalesce');
    assertBoolean(d.squash, 'defaults.squash');
  }

  if (raw.repos !== undefined) {
    if (!Array.isArray(raw.repos)) fail('repos', 'bir dizi (array) olmalı.');

    raw.repos.forEach((repo, ri) => {
      const rp = `repos[${ri}]`;
      if (!repo || typeof repo !== 'object' || Array.isArray(repo)) fail(rp, 'bir nesne olmalı.');
      assertString(repo.path, `${rp}.path`, { required: true });
      assertString(repo.name, `${rp}.name`);
      assertStringArray(repo.branches, `${rp}.branches`);
      assertStringArray(repo.triggers, `${rp}.triggers`);
      (repo.triggers || []).forEach((t, i) =>
        assertEnum(t, `${rp}.triggers[${i}]`, VALID_TRIGGERS)
      );

      if (repo.packages !== undefined) {
        if (!Array.isArray(repo.packages)) fail(`${rp}.packages`, 'bir dizi olmalı.');
        repo.packages.forEach((pkg, pi) => {
          const pp = `${rp}.packages[${pi}]`;
          if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) fail(pp, 'bir nesne olmalı.');
          assertString(pkg.path, `${pp}.path`, { required: true });
          assertString(pkg.name, `${pp}.name`);
          assertStringArray(pkg.triggers, `${pp}.triggers`);
          (pkg.triggers || []).forEach((t, i) =>
            assertEnum(t, `${pp}.triggers[${i}]`, VALID_TRIGGERS)
          );
          assertStringArray(pkg.branches, `${pp}.branches`);
          assertStringArray(pkg.commands, `${pp}.commands`);
          assertString(pkg.commitMessage, `${pp}.commitMessage`);
          assertPositiveNumber(pkg.commandTimeout, `${pp}.commandTimeout`);
          assertPositiveNumber(pkg.staleLockSec, `${pp}.staleLockSec`);
          assertPositiveNumber(pkg.waitTimeoutSec, `${pp}.waitTimeoutSec`, { allowZero: true });
          assertEnum(pkg.dirtyPolicy, `${pp}.dirtyPolicy`, VALID_DIRTY_POLICIES);
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
  'commitMessage',
  'commandTimeout',
  'debounceMs',
  'staleLockSec',
  'waitTimeoutSec',
  'dirtyPolicy',
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
  'commitMessage',
  'commandTimeout',
  'staleLockSec',
  'waitTimeoutSec',
  'dirtyPolicy',
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

  for (const k of unknownKeysOf(raw, KNOWN_ROOT_KEYS)) warnings.push(`bilinmeyen alan: ${k}`);
  for (const k of unknownKeysOf(raw.defaults, KNOWN_DEFAULTS_KEYS)) warnings.push(`bilinmeyen alan: defaults.${k}`);

  (Array.isArray(raw.repos) ? raw.repos : []).forEach((repo, ri) => {
    for (const k of unknownKeysOf(repo, KNOWN_REPO_KEYS)) warnings.push(`bilinmeyen alan: repos[${ri}].${k}`);
    const packages = repo && Array.isArray(repo.packages) ? repo.packages : [];
    packages.forEach((pkg, pi) => {
      for (const k of unknownKeysOf(pkg, KNOWN_PACKAGE_KEYS)) {
        warnings.push(`bilinmeyen alan: repos[${ri}].packages[${pi}].${k}`);
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
        commitMessage: pkg.commitMessage ?? defaults.commitMessage,
        commandTimeout: pkg.commandTimeout ?? defaults.commandTimeout,
        staleLockSec: pkg.staleLockSec ?? defaults.staleLockSec,
        waitTimeoutSec: pkg.waitTimeoutSec ?? defaults.waitTimeoutSec,
        dirtyPolicy: pkg.dirtyPolicy ?? defaults.dirtyPolicy,
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
      `Konfigürasyon dosyası bulunamadı: ${filePath}\n` +
        '"updeps init" ile örnek bir dosya oluşturabilirsin.'
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Konfigürasyon dosyası geçerli JSON değil: ${filePath}\n${err.message}`);
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
