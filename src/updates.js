/**
 * Update checks: which versions of the CLI and the desktop app are published,
 * and whether this install can update itself. The latest versions come from
 * the npm registry's dist-tags endpoint and are cached in `UPDATES_FILE` so
 * that most commands make no network call; the cache also holds the snooze of
 * the CLI update prompt. Nothing here throws on network or file problems.
 *
 * `UPDEPS_REGISTRY` replaces the registry URL (default https://registry.npmjs.org);
 * `UPDEPS_NO_NOTICES` (non-empty) turns the checks off: no request is made.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { STATE_DIR, UPDATES_FILE } from './paths.js';
import { BIN_PATH, realPathOr } from './launcher.js';

/** This CLI's npm package. */
export const CLI_PACKAGE = '@sqaft/updeps-cli';

/** The desktop app's npm package. */
export const APP_PACKAGE = '@sqaft/updeps-gui';

/** Manual command that updates the CLI. */
export const CLI_UPDATE_COMMAND = `npm install -g ${CLI_PACKAGE}`;

/** This install's package directory. */
export const CLI_ROOT = path.dirname(path.dirname(BIN_PATH));

/** The cache is used for this long when the last check succeeded... */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** ...and for this long when a lookup failed, so an offline machine is not slowed down on every command. */
const RETRY_INTERVAL_MS = 60 * 60 * 1000;
/** How long a declined CLI update is not offered again. */
const SNOOZE_MS = 24 * 60 * 60 * 1000;

const isWindows = process.platform === 'win32';

/**
 * Version in the package.json of a package directory.
 * @param {string} [root]
 * @returns {string|null} null when it cannot be read
 */
export function readInstalledVersion(root = CLI_ROOT) {
  try {
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** The version of this CLI as it was when the process started. */
export const CLI_VERSION = readInstalledVersion() ?? '0.0.0';

/**
 * @param {unknown} version
 * @returns {number[]|null} [major, minor, patch], or null when it is not an x.y.z version
 */
function parseVersion(version) {
  const m = typeof version === 'string' ? /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Whether `latest` is a higher x.y.z version than `current` (numeric
 * comparison; a pre-release suffix is ignored).
 * @param {string|null|undefined} latest
 * @param {string|null|undefined} current
 * @returns {boolean} false when either is missing or not a version
 */
export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** @returns {boolean} true when update checks are turned off with UPDEPS_NO_NOTICES */
export function noticesDisabled(env = process.env) {
  return Boolean(env.UPDEPS_NO_NOTICES);
}

/**
 * The `latest` dist-tag of a package on the npm registry.
 * @param {string} name  package name, e.g. "@sqaft/updeps-gui"
 * @param {{ timeoutMs?: number, registry?: string }} [opts]
 * @returns {Promise<string|null>} null for any failure: network, status, JSON, shape
 */
export async function fetchLatestVersion(name, { timeoutMs = 1500, registry = process.env.UPDEPS_REGISTRY || 'https://registry.npmjs.org' } = {}) {
  try {
    const url = `${registry.replace(/\/+$/, '')}/-/package/${name.replace('/', '%2f')}/dist-tags`;
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const latest = (await res.json())?.latest;
    return parseVersion(latest) ? latest : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {object} UpdatesCache
 * @property {number} checkedAt  ms epoch of the last lookup
 * @property {number} nextCheckAt  ms epoch before which the cached versions are used
 * @property {string|null} cli  latest published CLI version
 * @property {string|null} app  latest published desktop app version
 * @property {{ version: string, until: number }|null} snooze  the CLI version whose prompt was declined, and until when
 */

/** @returns {UpdatesCache} the cache file's content; defaults for a missing or corrupt file */
export function readCache() {
  const cache = { checkedAt: 0, nextCheckAt: 0, cli: null, app: null, snooze: null };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(UPDATES_FILE, 'utf8'));
  } catch {
    return cache;
  }
  if (!raw || typeof raw !== 'object') return cache;
  if (Number.isFinite(raw.checkedAt)) cache.checkedAt = raw.checkedAt;
  if (Number.isFinite(raw.nextCheckAt)) cache.nextCheckAt = raw.nextCheckAt;
  if (parseVersion(raw.cli)) cache.cli = raw.cli;
  if (parseVersion(raw.app)) cache.app = raw.app;
  if (typeof raw.snooze?.version === 'string' && Number.isFinite(raw.snooze.until)) {
    cache.snooze = { version: raw.snooze.version, until: raw.snooze.until };
  }
  return cache;
}

/**
 * Read-modify-write of the cache file; written to a temp file and renamed so a
 * concurrent reader sees the old or the new content. Write failures are ignored.
 * @param {(cache: UpdatesCache) => void} change
 * @returns {UpdatesCache} the updated cache
 */
function updateCache(change) {
  const cache = readCache();
  change(cache);
  const tmp = path.join(STATE_DIR, `.updates.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, UPDATES_FILE);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing to clean up */
    }
  }
  return cache;
}

/**
 * Whether the prompt for this CLI version was declined less than a day ago.
 * A newer version than the snoozed one is not snoozed.
 * @param {string} version
 * @param {number} [now]
 * @returns {boolean}
 */
export function isSnoozed(version, now = Date.now()) {
  const { snooze } = readCache();
  return Boolean(snooze) && snooze.version === version && snooze.until > now;
}

/**
 * Remembers that the prompt for this CLI version was declined; it is not shown
 * again for a day.
 * @param {string} version
 * @param {number} [now]
 */
export function snoozeVersion(version, now = Date.now()) {
  updateCache((cache) => {
    cache.snooze = { version, until: now + SNOOZE_MS };
  });
}

/** @returns {string|null} the output of `npm root -g`, or null when npm cannot tell */
function npmGlobalRoot() {
  // npm is a .cmd script on Windows, which Node only runs through a shell.
  const res = spawnSync('npm', ['root', '-g'], {
    encoding: 'utf8',
    shell: isWindows,
    timeout: 5000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const root = res.status === 0 ? (res.stdout || '').trim() : '';
  return root || null;
}

/**
 * Whether this install is a global npm install that `npm install -g` would
 * replace: its directory is inside a `node_modules`, is not a git checkout,
 * and is the very directory where the `npm` on the PATH keeps global packages,
 * not a link to somewhere else (which rules out a linked working copy, and an
 * npm that belongs to another Node, as with version managers). The cheap path checks run first; `npm root -g`
 * is spawned only when they pass.
 * @param {{ root?: string, npmRoot?: string|null|(() => string|null) }} [opts]
 *   `root` is the package directory, `npmRoot` the global root (or a function returning it)
 * @returns {boolean}
 */
export function canSelfUpdate({ root = CLI_ROOT, npmRoot = npmGlobalRoot } = {}) {
  if (!root.split(path.sep).includes('node_modules')) return false;
  if (fs.existsSync(path.join(root, '.git'))) return false;
  const globalRoot = typeof npmRoot === 'function' ? npmRoot() : npmRoot;
  if (!globalRoot) return false;
  const entry = path.join(globalRoot, ...CLI_PACKAGE.split('/'));
  try {
    // `npm link` makes the global entry a symlink to a working copy; npm would replace the link, not the copy.
    if (fs.lstatSync(entry).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  const expected = realPathOr(entry);
  const actual = realPathOr(root);
  return isWindows ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}

/**
 * The latest published versions of the CLI and the desktop app, from the cache
 * when it is fresh. A lookup runs when the cache is older than 24 hours (an
 * hour after a failed lookup, which keeps the versions cached before) or when
 * `force` is set. Never throws.
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]  look up even when the cache is fresh
 * @param {number} [opts.timeoutMs=1500]  per lookup
 * @param {number} [opts.now]  ms epoch, for tests
 * @param {() => boolean} [opts.canUpdate]  whether this install can update itself (default `canSelfUpdate`), for tests
 * @returns {Promise<{
 *   cli: { current: string, latest: string|null, update: boolean, command: string },
 *   app: { latest: string|null }
 * }>} `cli.update` is true when a newer CLI exists and this install can update itself;
 *   everything is null/false when UPDEPS_NO_NOTICES is set
 */
export async function checkUpdates({ force = false, timeoutMs = 1500, now = Date.now(), canUpdate = canSelfUpdate } = {}) {
  const build = (cliLatest, appLatest) => {
    let update = false;
    try {
      update = isNewer(cliLatest, CLI_VERSION) && Boolean(canUpdate());
    } catch {
      /* an install that cannot be inspected is not updated */
    }
    return {
      cli: { current: CLI_VERSION, latest: cliLatest, update, command: CLI_UPDATE_COMMAND },
      app: { latest: appLatest }
    };
  };

  if (noticesDisabled()) return build(null, null);
  try {
    let cache = readCache();
    const fresh = !force && cache.nextCheckAt > now && cache.nextCheckAt - now <= CHECK_INTERVAL_MS;
    if (!fresh) {
      const [cli, app] = await Promise.all([
        fetchLatestVersion(CLI_PACKAGE, { timeoutMs }),
        fetchLatestVersion(APP_PACKAGE, { timeoutMs })
      ]);
      cache = updateCache((c) => {
        c.checkedAt = now;
        c.nextCheckAt = now + (cli && app ? CHECK_INTERVAL_MS : RETRY_INTERVAL_MS);
        c.cli = cli ?? c.cli;
        c.app = app ?? c.app;
      });
    }
    return build(cache.cli, cache.app);
  } catch {
    return build(null, null);
  }
}
