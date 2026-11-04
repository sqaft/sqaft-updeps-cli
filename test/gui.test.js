import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers.js';

const { dir, cleanup } = tmpDir('updeps-gui-');
process.env.XDG_DATA_HOME = path.join(dir, 'data');

const { findApp, installedApp, openApp, installApp, quitApp, offerAppUpdate, APP_PACKAGE } = await import('../src/commands/gui.js');
const { DESKTOP_APP_DIR } = await import('../src/paths.js');
const { BIN_PATH } = await import('../src/launcher.js');

test.after(() => {
  delete process.env.UPDEPS_GUI;
  cleanup();
});

/** A fake app package; `quit` is the exit code of `--quit`. */
function fakeQuittingApp(root, { quit = 1, version = '1.2.3', out = path.join(root, 'quit.txt') } = {}) {
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: APP_PACKAGE, version, bin: { 'updeps-gui': 'bin/updeps-gui.js' } })
  );
  fs.writeFileSync(
    path.join(root, 'bin', 'updeps-gui.js'),
    `const fs = require('node:fs');\n` +
      `if (process.argv.includes('--quit')) { fs.writeFileSync(${JSON.stringify(out)}, 'quit'); process.exit(${quit}); }\n`
  );
  return root;
}

/** A fake app package whose launcher writes the UPDEPS_CLI it got to `out`. */
function fakeApp(root, { name = APP_PACKAGE, out = path.join(root, 'cli.txt') } = {}) {
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name, version: '1.2.3', bin: { 'updeps-gui': 'bin/updeps-gui.js' } })
  );
  fs.writeFileSync(
    path.join(root, 'bin', 'updeps-gui.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(out)}, process.env.UPDEPS_CLI || '');\n`
  );
  return root;
}

test('findApp: not installed, installed by `updeps gui install`, or a checkout in UPDEPS_GUI', () => {
  delete process.env.UPDEPS_GUI;
  assert.equal(findApp(), null);

  const installed = fakeApp(path.join(DESKTOP_APP_DIR, 'node_modules', ...APP_PACKAGE.split('/')));
  assert.deepEqual(findApp(), { root: installed, version: '1.2.3', bin: path.join(installed, 'bin', 'updeps-gui.js') });

  process.env.UPDEPS_GUI = fakeApp(path.join(dir, 'checkout'));
  assert.equal(findApp().root, path.join(dir, 'checkout'));

  process.env.UPDEPS_GUI = fakeApp(path.join(dir, 'other'), { name: 'something-else' });
  assert.equal(findApp(), null);
  delete process.env.UPDEPS_GUI;
});

test('openApp tells the app which CLI install to work with', () => {
  const app = fakeApp(path.join(dir, 'launch'));
  openApp({ root: app, bin: path.join(app, 'bin', 'updeps-gui.js') });
  assert.equal(fs.readFileSync(path.join(app, 'cli.txt'), 'utf8'), path.dirname(path.dirname(BIN_PATH)));
});

test('installedApp ignores UPDEPS_GUI', () => {
  const installed = fakeApp(path.join(DESKTOP_APP_DIR, 'node_modules', ...APP_PACKAGE.split('/')));
  process.env.UPDEPS_GUI = fakeApp(path.join(dir, 'checkout2'));
  try {
    assert.equal(findApp().root, path.join(dir, 'checkout2'));
    assert.equal(installedApp().root, installed);
  } finally {
    delete process.env.UPDEPS_GUI;
    fs.rmSync(DESKTOP_APP_DIR, { recursive: true, force: true });
  }
});

test('quitApp: true when the app quits, false when --quit fails or is unknown', () => {
  const ok = fakeQuittingApp(path.join(dir, 'quit-ok'), { quit: 0 });
  const old = fakeQuittingApp(path.join(dir, 'quit-old'), { quit: 1 });
  assert.equal(quitApp({ bin: path.join(ok, 'bin', 'updeps-gui.js') }), true);
  assert.equal(fs.readFileSync(path.join(ok, 'quit.txt'), 'utf8'), 'quit');
  assert.equal(quitApp({ bin: path.join(old, 'bin', 'updeps-gui.js') }), false);
  assert.equal(quitApp({ bin: path.join(dir, 'missing.js') }), false);
});

/**
 * A process runner for `installApp`: records the calls, answers `npm install`
 * by putting a package of version 2.0.0 where npm would, and lets every other
 * process (the old app's --quit, --prepare) run for real.
 */
function fakeSpawn(calls) {
  return (command, args, options) => {
    if (command !== 'npm') {
      calls.push(['node', ...args.slice(1)]);
      return options.stdio === 'ignore' ? spawnSync(command, args, options) : { status: 0 };
    }
    calls.push(['npm', ...args]);
    const root = path.join(DESKTOP_APP_DIR, 'node_modules', ...APP_PACKAGE.split('/'));
    fakeQuittingApp(root, { quit: 0, version: '2.0.0' });
    return { status: 0 };
  };
}

/** Collects what `fn` prints with console.log. */
async function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' ').replace(/\x1b\[\d+m/g, ''));
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = original;
  }
}

const QUIT_NOTE = 'If the desktop app is still running, quit it from the tray and run "updeps gui" again.';

test('installApp: an installed app that does not know --quit does not abort the update', async () => {
  fs.rmSync(DESKTOP_APP_DIR, { recursive: true, force: true });
  const root = path.join(DESKTOP_APP_DIR, 'node_modules', ...APP_PACKAGE.split('/'));
  fakeQuittingApp(root, { quit: 1 }); // GUI 0.0.1: "Unknown option", exit 1
  const calls = [];
  const { result, lines } = await captureLog(() => installApp({ spawn: fakeSpawn(calls) }));

  assert.equal(result.version, '2.0.0');
  assert.equal(fs.readFileSync(path.join(root, 'quit.txt'), 'utf8'), 'quit', '--quit was attempted before npm replaced the files');
  assert.deepEqual(calls.map((c) => c[0]), ['node', 'npm', 'node'], 'quit, npm install, prepare');
  assert.deepEqual(calls[0].slice(1), ['--quit']);
  assert.deepEqual(calls[2].slice(1), ['--prepare']);
  assert.deepEqual(lines, [QUIT_NOTE]);
  fs.rmSync(DESKTOP_APP_DIR, { recursive: true, force: true });
});

test('installApp: a successful --quit prints no note, and a first install quits nothing', async () => {
  fs.rmSync(DESKTOP_APP_DIR, { recursive: true, force: true });
  const root = path.join(DESKTOP_APP_DIR, 'node_modules', ...APP_PACKAGE.split('/'));
  fakeQuittingApp(root, { quit: 0 });
  let calls = [];
  let run = await captureLog(() => installApp({ spawn: fakeSpawn(calls) }));
  assert.deepEqual(run.lines, []);
  assert.deepEqual(calls.map((c) => c[0]), ['node', 'npm', 'node']);

  fs.rmSync(DESKTOP_APP_DIR, { recursive: true, force: true });
  calls = [];
  run = await captureLog(() => installApp({ spawn: fakeSpawn(calls) }));
  assert.deepEqual(run.lines, []);
  assert.deepEqual(calls.map((c) => c[0]), ['npm', 'node'], 'nothing installed yet, so nothing to quit');
  fs.rmSync(DESKTOP_APP_DIR, { recursive: true, force: true });
});

test('installApp: a failing npm still throws', () => {
  fs.rmSync(DESKTOP_APP_DIR, { recursive: true, force: true });
  assert.throws(() => installApp({ spawn: () => ({ status: 1 }) }), /npm install @sqaft\/updeps-gui failed/);
  fs.rmSync(DESKTOP_APP_DIR, { recursive: true, force: true });
});

const APP = { root: '/app', version: '0.0.1', bin: '/app/bin/updeps-gui.js' };

/** Deps for `offerAppUpdate` in a terminal, with the latest app version `latest`. */
function appUpdateDeps(latest, overrides = {}) {
  const calls = { checks: [], asked: [], installs: 0 };
  return {
    calls,
    deps: {
      env: {},
      tty: true,
      check: async (opts) => (calls.checks.push(opts), { app: { latest } }),
      ask: async (question) => (calls.asked.push(question), true),
      install: () => (calls.installs++, { root: '/app', version: latest, bin: '/app/bin/updeps-gui.js' }),
      ...overrides
    }
  };
}

test('offerAppUpdate: asks every time a newer app is published, and a yes installs it', async () => {
  const { deps, calls } = appUpdateDeps('0.0.2');
  const { result, lines } = await captureLog(() => offerAppUpdate(APP, deps));
  assert.equal(result.version, '0.0.2');
  assert.deepEqual(calls.checks, [{ force: true, timeoutMs: 3000 }]);
  assert.deepEqual(calls.asked, ['Update now? [Y/n] ']);
  assert.equal(calls.installs, 1);
  assert.equal(lines[0], 'Desktop app 0.0.2 is available (installed: 0.0.1). Updating closes the running app.');

  // No snooze: the next run asks again.
  const again = appUpdateDeps('0.0.2');
  await captureLog(() => offerAppUpdate(APP, again.deps));
  assert.equal(again.calls.asked.length, 1);
});

test('offerAppUpdate: a no, an unknown latest or an app that is up to date opens the installed app', async () => {
  let t = appUpdateDeps('0.0.2', { ask: async () => false });
  assert.equal(await offerAppUpdate(APP, t.deps), APP);
  assert.equal(t.calls.installs, 0);

  t = appUpdateDeps(null);
  assert.equal(await offerAppUpdate(APP, t.deps), APP);
  assert.equal(t.calls.asked.length, 0);

  t = appUpdateDeps('0.0.1');
  assert.equal(await offerAppUpdate(APP, t.deps), APP);
  t = appUpdateDeps('0.0.0');
  assert.equal(await offerAppUpdate(APP, t.deps), APP);
  assert.equal(t.calls.asked.length, 0);
});

test('offerAppUpdate: no check without a terminal, with UPDEPS_GUI or with UPDEPS_NO_NOTICES', async () => {
  for (const overrides of [{ tty: false }, { env: { UPDEPS_GUI: '/checkout' } }, { env: { UPDEPS_NO_NOTICES: '1' } }]) {
    const t = appUpdateDeps('9.9.9', overrides);
    assert.equal(await offerAppUpdate(APP, t.deps), APP);
    assert.deepEqual(t.calls.checks, []);
    assert.equal(t.calls.asked.length, 0);
  }
});

test('offerAppUpdate: a failing update prints the error and opens the installed app anyway', async () => {
  const installed = fakeApp(path.join(DESKTOP_APP_DIR, 'node_modules', ...APP_PACKAGE.split('/')));
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' ').replace(/\x1b\[\d+m/g, ''));
  try {
    const t = appUpdateDeps('0.0.2', {
      install: () => {
        throw new Error('npm install failed');
      }
    });
    const { result } = await captureLog(() => offerAppUpdate(APP, t.deps));
    assert.equal(result.root, installed);
    assert.deepEqual(errors, ['npm install failed']);
  } finally {
    console.error = original;
  }

  // With nothing left to open the error propagates.
  fs.rmSync(DESKTOP_APP_DIR, { recursive: true, force: true });
  const t = appUpdateDeps('0.0.2', {
    install: () => {
      throw new Error('npm install failed');
    }
  });
  await assert.rejects(captureLog(() => offerAppUpdate(APP, t.deps)), /npm install failed/);
});
