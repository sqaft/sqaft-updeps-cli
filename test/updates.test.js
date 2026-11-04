import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { tmpDir } from './helpers.js';

const { dir, cleanup } = tmpDir('updeps-updates-');
process.env.XDG_STATE_HOME = path.join(dir, 'state');

const { UPDATES_FILE } = await import('../src/paths.js');
const updates = await import('../src/updates.js');
const { CLI_PACKAGE, APP_PACKAGE, CLI_VERSION, isNewer, checkUpdates, canSelfUpdate, fetchLatestVersion, isSnoozed, snoozeVersion } = updates;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * A fake npm registry. `tags` maps a package name to its dist-tags response
 * (a status code or an object); `requests` collects the request paths.
 */
async function registry(tags) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const match = /^\/-\/package\/(.+)\/dist-tags$/.exec(req.url);
    const name = match && decodeURIComponent(match[1]);
    const reply = tags[name];
    if (typeof reply === 'number') {
      res.statusCode = reply;
      res.end('{}');
    } else if (typeof reply === 'string') {
      res.end(reply);
    } else if (reply) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    set: (next) => Object.assign(tags, next),
    close: () => server.closeAllConnections() ?? new Promise((resolve) => server.close(resolve))
  };
}

/** Runs `fn` with notices on and UPDEPS_REGISTRY pointing at `url`; starts every test with no cache. */
async function withRegistry(url, fn) {
  fs.rmSync(UPDATES_FILE, { force: true });
  delete process.env.UPDEPS_NO_NOTICES;
  process.env.UPDEPS_REGISTRY = url;
  try {
    return await fn();
  } finally {
    process.env.UPDEPS_NO_NOTICES = '1';
    delete process.env.UPDEPS_REGISTRY;
  }
}

test.after(cleanup);

test('isNewer compares x.y.z numerically', () => {
  assert.equal(isNewer('0.3.0', '0.2.0'), true);
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
  assert.equal(isNewer('1.2.4', '1.2.3'), true);
  assert.equal(isNewer('v1.2.4', '1.2.3'), true);
  assert.equal(isNewer('0.2.0', '0.2.0'), false);
  assert.equal(isNewer('0.1.9', '0.2.0'), false);
  assert.equal(isNewer('0.2.0', '0.10.0'), false);
  assert.equal(isNewer('2.0.0', '10.0.0'), false);
  assert.equal(isNewer(null, '1.0.0'), false);
  assert.equal(isNewer('1.0.0', null), false);
  assert.equal(isNewer(undefined, undefined), false);
  assert.equal(isNewer('latest', '1.0.0'), false);
  assert.equal(isNewer('1.0', '0.9.0'), false);
  assert.equal(isNewer(42, '1.0.0'), false);
});

test('fetchLatestVersion reads the latest dist-tag from the registry', async () => {
  const reg = await registry({ [APP_PACKAGE]: { latest: '0.0.7', next: '0.1.0-beta.1' } });
  try {
    assert.equal(await fetchLatestVersion(APP_PACKAGE, { registry: reg.url }), '0.0.7');
    assert.deepEqual(reg.requests, ['/-/package/@sqaft%2fupdeps-gui/dist-tags']);
    // A trailing slash on the registry URL is fine.
    assert.equal(await fetchLatestVersion(APP_PACKAGE, { registry: `${reg.url}/` }), '0.0.7');
  } finally {
    await reg.close();
  }
});

test('fetchLatestVersion: any failure is null, never a throw', async () => {
  const reg = await registry({
    'a-500': 500,
    'a-text': 'not json',
    'a-shape': { latest: 7 },
    'a-garbage': { latest: 'banana' },
    'a-array': '[]'
  });
  try {
    for (const name of ['a-500', 'a-text', 'a-shape', 'a-garbage', 'a-array', 'a-missing']) {
      assert.equal(await fetchLatestVersion(name, { registry: reg.url }), null, name);
    }
  } finally {
    await reg.close();
  }
  // Nothing listens on the port any more.
  assert.equal(await fetchLatestVersion('x', { registry: reg.url }), null);
});

test('fetchLatestVersion gives up after the timeout', async () => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const started = Date.now();
    const latest = await fetchLatestVersion('slow', { registry: `http://127.0.0.1:${server.address().port}`, timeoutMs: 100 });
    assert.equal(latest, null);
    assert.ok(Date.now() - started < 3000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('checkUpdates: looks up both packages, caches them, and reports an available CLI update', async () => {
  const reg = await registry({ [CLI_PACKAGE]: { latest: '99.0.0' }, [APP_PACKAGE]: { latest: '0.4.0' } });
  try {
    await withRegistry(reg.url, async () => {
      const result = await checkUpdates({ canUpdate: () => true });
      assert.deepEqual(result, {
        cli: { current: CLI_VERSION, latest: '99.0.0', update: true, command: `npm install -g ${CLI_PACKAGE}` },
        app: { latest: '0.4.0' }
      });
      assert.equal(reg.requests.length, 2);

      const cache = JSON.parse(fs.readFileSync(UPDATES_FILE, 'utf8'));
      assert.equal(cache.cli, '99.0.0');
      assert.equal(cache.app, '0.4.0');
      assert.equal(typeof cache.checkedAt, 'number');
    });
  } finally {
    await reg.close();
  }
});

test('checkUpdates: cli.update needs a newer version AND an install that can update itself', async () => {
  const reg = await registry({ [CLI_PACKAGE]: { latest: '99.0.0' }, [APP_PACKAGE]: { latest: '0.4.0' } });
  try {
    await withRegistry(reg.url, async () => {
      assert.equal((await checkUpdates({ canUpdate: () => false })).cli.update, false);
      assert.equal((await checkUpdates({ canUpdate: () => { throw new Error('boom'); } })).cli.update, false);

      // The test checkout is not a global install, so the real check says no.
      const real = await checkUpdates();
      assert.equal(real.cli.latest, '99.0.0');
      assert.equal(real.cli.update, false);

      // Not newer: the install check is not even asked.
      reg.set({ [CLI_PACKAGE]: { latest: CLI_VERSION } });
      let asked = false;
      const same = await checkUpdates({ force: true, canUpdate: () => (asked = true) });
      assert.equal(same.cli.update, false);
      assert.equal(asked, false);
    });
  } finally {
    await reg.close();
  }
});

test('checkUpdates: a cache younger than 24 hours is used, an older one and force look up again', async () => {
  const reg = await registry({ [CLI_PACKAGE]: { latest: '1.0.0' }, [APP_PACKAGE]: { latest: '2.0.0' } });
  try {
    await withRegistry(reg.url, async () => {
      const t0 = 1_000_000_000_000;
      await checkUpdates({ now: t0 });
      assert.equal(reg.requests.length, 2);

      reg.set({ [CLI_PACKAGE]: { latest: '1.1.0' }, [APP_PACKAGE]: { latest: '2.1.0' } });
      const cached = await checkUpdates({ now: t0 + DAY - HOUR });
      assert.equal(reg.requests.length, 2);
      assert.equal(cached.cli.latest, '1.0.0');
      assert.equal(cached.app.latest, '2.0.0');

      const forced = await checkUpdates({ now: t0 + HOUR, force: true });
      assert.equal(reg.requests.length, 4);
      assert.equal(forced.cli.latest, '1.1.0');
      assert.equal(forced.app.latest, '2.1.0');

      reg.set({ [CLI_PACKAGE]: { latest: '1.2.0' }, [APP_PACKAGE]: { latest: '2.2.0' } });
      const stale = await checkUpdates({ now: t0 + HOUR + DAY + 1 });
      assert.equal(reg.requests.length, 6);
      assert.equal(stale.cli.latest, '1.2.0');
    });
  } finally {
    await reg.close();
  }
});

test('checkUpdates: a corrupt or missing cache file is a cache miss', async () => {
  const reg = await registry({ [CLI_PACKAGE]: { latest: '1.0.0' }, [APP_PACKAGE]: { latest: '2.0.0' } });
  try {
    await withRegistry(reg.url, async () => {
      fs.mkdirSync(path.dirname(UPDATES_FILE), { recursive: true });
      for (const content of ['{ nope', '', 'null', '[1]', JSON.stringify({ checkedAt: 'x', nextCheckAt: 'y', cli: 5, app: {} })]) {
        fs.writeFileSync(UPDATES_FILE, content);
        reg.requests.length = 0;
        const result = await checkUpdates();
        assert.equal(result.cli.latest, '1.0.0', content);
        assert.equal(reg.requests.length, 2, content);
        assert.equal(JSON.parse(fs.readFileSync(UPDATES_FILE, 'utf8')).app, '2.0.0');
      }
    });
  } finally {
    await reg.close();
  }
});

test('checkUpdates: a failed lookup keeps the cached versions and is retried after an hour', async () => {
  const reg = await registry({ [CLI_PACKAGE]: { latest: '1.0.0' }, [APP_PACKAGE]: { latest: '2.0.0' } });
  try {
    await withRegistry(reg.url, async () => {
      const t0 = 1_000_000_000_000;
      await checkUpdates({ now: t0 });
      assert.equal(reg.requests.length, 2);

      // A day later the registry is down.
      reg.set({ [CLI_PACKAGE]: 503, [APP_PACKAGE]: 503 });
      const t1 = t0 + DAY + 1;
      const failed = await checkUpdates({ now: t1 });
      assert.equal(reg.requests.length, 4);
      assert.equal(failed.cli.latest, '1.0.0');
      assert.equal(failed.app.latest, '2.0.0');

      // Within the hour nothing is requested.
      await checkUpdates({ now: t1 + HOUR - 1000 });
      assert.equal(reg.requests.length, 4);

      // After the hour it tries again, and a recovered registry replaces the old versions.
      reg.set({ [CLI_PACKAGE]: { latest: '1.5.0' }, [APP_PACKAGE]: { latest: '2.5.0' } });
      const recovered = await checkUpdates({ now: t1 + HOUR + 1 });
      assert.equal(reg.requests.length, 6);
      assert.equal(recovered.cli.latest, '1.5.0');
      assert.equal(recovered.app.latest, '2.5.0');

      // And the next lookup is a day away again.
      await checkUpdates({ now: t1 + HOUR + 2 + HOUR });
      assert.equal(reg.requests.length, 6);
    });
  } finally {
    await reg.close();
  }
});

test('checkUpdates: an unreachable registry yields unknown versions and does not throw', async () => {
  const reg = await registry({});
  const url = reg.url;
  await reg.close();
  await withRegistry(url, async () => {
    const result = await checkUpdates({ canUpdate: () => true });
    assert.deepEqual(result, {
      cli: { current: CLI_VERSION, latest: null, update: false, command: `npm install -g ${CLI_PACKAGE}` },
      app: { latest: null }
    });
  });
});

test('UPDEPS_NO_NOTICES makes no request and returns nulls', async () => {
  const reg = await registry({ [CLI_PACKAGE]: { latest: '99.0.0' }, [APP_PACKAGE]: { latest: '99.0.0' } });
  try {
    fs.rmSync(UPDATES_FILE, { force: true });
    process.env.UPDEPS_REGISTRY = reg.url;
    process.env.UPDEPS_NO_NOTICES = '1';
    const result = await checkUpdates({ force: true, canUpdate: () => true });
    assert.equal(result.cli.latest, null);
    assert.equal(result.cli.update, false);
    assert.equal(result.app.latest, null);
    assert.equal(reg.requests.length, 0);
    assert.equal(fs.existsSync(UPDATES_FILE), false);
  } finally {
    delete process.env.UPDEPS_REGISTRY;
    await reg.close();
  }
});

test('snooze: a declined version is hidden for a day, a newer one is not, and lookups keep the snooze', async () => {
  const reg = await registry({ [CLI_PACKAGE]: { latest: '99.0.0' }, [APP_PACKAGE]: { latest: '1.0.0' } });
  try {
    await withRegistry(reg.url, async () => {
      const t0 = 1_000_000_000_000;
      assert.equal(isSnoozed('99.0.0', t0), false);

      snoozeVersion('99.0.0', t0);
      assert.equal(isSnoozed('99.0.0', t0 + DAY - 1), true);
      assert.equal(isSnoozed('99.0.0', t0 + DAY), false);
      assert.equal(isSnoozed('99.0.1', t0 + 1), false);

      // A lookup writes versions into the same file without losing the snooze...
      await checkUpdates({ now: t0 + 1 });
      assert.equal(isSnoozed('99.0.0', t0 + 2), true);
      assert.equal(JSON.parse(fs.readFileSync(UPDATES_FILE, 'utf8')).cli, '99.0.0');

      // ...and snoozing keeps the cached versions.
      snoozeVersion('99.0.1', t0 + 3);
      assert.equal(isSnoozed('99.0.0', t0 + 4), false);
      assert.equal(isSnoozed('99.0.1', t0 + 4), true);
      assert.equal(JSON.parse(fs.readFileSync(UPDATES_FILE, 'utf8')).app, '1.0.0');
    });
  } finally {
    await reg.close();
  }
});

test('the cache file leaves no temp files behind', async () => {
  fs.rmSync(UPDATES_FILE, { force: true });
  snoozeVersion('1.2.3');
  assert.deepEqual(
    fs.readdirSync(path.dirname(UPDATES_FILE)).filter((f) => f.includes('updates')),
    ['updates.json']
  );
});

/** A directory layout like a global npm install: <prefix>/lib/node_modules/@sqaft/updeps-cli. */
function globalLayout(base) {
  const globalRoot = path.join(base, 'prefix', 'lib', 'node_modules');
  const root = path.join(globalRoot, ...CLI_PACKAGE.split('/'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  return { globalRoot, root };
}

test('canSelfUpdate: true for the package inside npm\'s global root', () => {
  const { globalRoot, root } = globalLayout(path.join(dir, 'global'));
  assert.equal(canSelfUpdate({ root, npmRoot: globalRoot }), true);
  assert.equal(canSelfUpdate({ root, npmRoot: () => globalRoot }), true);
});

test('canSelfUpdate: false for a working copy linked into the global root', { skip: process.platform === 'win32' && 'symlinks need privileges' }, () => {
  const base = path.join(dir, 'linked');
  const workingCopy = path.join(base, 'work', 'sqaft-updeps-cli');
  fs.mkdirSync(path.join(workingCopy, 'bin'), { recursive: true });
  const globalRoot = path.join(base, 'prefix', 'lib', 'node_modules');
  fs.mkdirSync(path.join(globalRoot, '@sqaft'), { recursive: true });
  fs.symlinkSync(workingCopy, path.join(globalRoot, ...CLI_PACKAGE.split('/')), 'dir');

  // `npm link` makes the global entry a symlink to the checkout. A process started
  // through it runs from the checkout's real path, which `npm install -g` would not replace.
  const entry = path.join(globalRoot, ...CLI_PACKAGE.split('/'));
  assert.equal(canSelfUpdate({ root: fs.realpathSync(entry), npmRoot: globalRoot }), false);
  // Also when the process was started through the link's own path.
  assert.equal(canSelfUpdate({ root: entry, npmRoot: globalRoot }), false);
});

test('canSelfUpdate: false for a checkout that sits inside a node_modules directory', () => {
  const { globalRoot, root } = globalLayout(path.join(dir, 'checkout'));
  fs.mkdirSync(path.join(root, '.git'));
  assert.equal(canSelfUpdate({ root, npmRoot: globalRoot }), false);
});

test('canSelfUpdate: false outside node_modules, without spawning npm', () => {
  const root = path.join(dir, 'work', 'sqaft-updeps-cli');
  fs.mkdirSync(root, { recursive: true });
  let spawned = false;
  assert.equal(canSelfUpdate({ root, npmRoot: () => ((spawned = true), path.dirname(root)) }), false);
  assert.equal(spawned, false);
});

test('canSelfUpdate: false when npm keeps global packages somewhere else, or cannot say where', () => {
  const { root } = globalLayout(path.join(dir, 'nvm'));
  const otherPrefix = path.join(dir, 'other-node', 'lib', 'node_modules');
  fs.mkdirSync(otherPrefix, { recursive: true });
  assert.equal(canSelfUpdate({ root, npmRoot: otherPrefix }), false);
  assert.equal(canSelfUpdate({ root, npmRoot: null }), false);
  assert.equal(canSelfUpdate({ root, npmRoot: () => null }), false);
});

test('canSelfUpdate: this working copy is not self-updatable', () => {
  assert.equal(canSelfUpdate(), false);
});
