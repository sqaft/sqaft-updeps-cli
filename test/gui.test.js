import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers.js';

const { dir, cleanup } = tmpDir('updeps-gui-');
process.env.XDG_DATA_HOME = path.join(dir, 'data');

const { findApp, openApp, APP_PACKAGE } = await import('../src/commands/gui.js');
const { DESKTOP_APP_DIR } = await import('../src/paths.js');
const { BIN_PATH } = await import('../src/launcher.js');

test.after(() => {
  delete process.env.UPDEPS_APP;
  cleanup();
});

/** A fake app package whose launcher writes the UPDEPS_CLI it got to `out`. */
function fakeApp(root, { name = APP_PACKAGE, out = path.join(root, 'cli.txt') } = {}) {
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name, version: '1.2.3', bin: { 'updeps-app': 'bin/updeps-app.js' } })
  );
  fs.writeFileSync(
    path.join(root, 'bin', 'updeps-app.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(out)}, process.env.UPDEPS_CLI || '');\n`
  );
  return root;
}

test('findApp: not installed, installed by `updeps gui install`, or a checkout in UPDEPS_APP', () => {
  delete process.env.UPDEPS_APP;
  assert.equal(findApp(), null);

  const installed = fakeApp(path.join(DESKTOP_APP_DIR, 'node_modules', ...APP_PACKAGE.split('/')));
  assert.deepEqual(findApp(), { root: installed, version: '1.2.3', bin: path.join(installed, 'bin', 'updeps-app.js') });

  process.env.UPDEPS_APP = fakeApp(path.join(dir, 'checkout'));
  assert.equal(findApp().root, path.join(dir, 'checkout'));

  process.env.UPDEPS_APP = fakeApp(path.join(dir, 'other'), { name: 'something-else' });
  assert.equal(findApp(), null);
  delete process.env.UPDEPS_APP;
});

test('openApp tells the app which CLI install to work with', () => {
  const app = fakeApp(path.join(dir, 'launch'));
  openApp({ root: app, bin: path.join(app, 'bin', 'updeps-app.js') });
  assert.equal(fs.readFileSync(path.join(app, 'cli.txt'), 'utf8'), path.dirname(path.dirname(BIN_PATH)));
});
