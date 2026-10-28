import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpDir } from './helpers.js';

const { dir, cleanup } = tmpDir('updeps-watcher-');
process.env.XDG_STATE_HOME = path.join(dir, 'state');
process.env.XDG_CONFIG_HOME = path.join(dir, 'config');

const { CONFIG_FILE, CONFIG_DIR } = await import('../src/paths.js');
const { resolveConfig, saveConfig } = await import('../src/config.js');
const { UpdateQueue } = await import('../src/queue.js');
const { ReflogWatcher } = await import('../src/watcher.js');

test.after(cleanup);

function baseConfig() {
  return { notifications: false, repos: [] };
}

test('onConfigChange fires when the config changes, including on consecutive atomic writes', async () => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  saveConfig(baseConfig());

  let reloads = 0;
  const config = resolveConfig(baseConfig());
  const queue = new UpdateQueue(config, { onGroupDone: () => {} });
  const watcher = new ReflogWatcher(config, queue, () => {
    reloads++;
  });
  watcher.start();
  await sleep(100);

  // saveConfig() replaces the file via write-temp + rename (the inode changes).
  saveConfig({ ...baseConfig(), notifications: true });
  for (let i = 0; i < 40 && reloads < 1; i++) await sleep(50);
  assert.equal(reloads, 1, 'the first change should trigger a reload');

  // Second write: the watch must still be live after the inode swap.
  saveConfig({ ...baseConfig(), notifications: false });
  for (let i = 0; i < 40 && reloads < 2; i++) await sleep(50);
  assert.equal(reloads, 2, 'the second change should trigger as well');

  await watcher.stop();
});

function g(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeSourceRepo(root) {
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(source);
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  g(['init', '-q', '-b', 'main'], source);
  g(['config', 'user.email', 't@t.t'], source);
  g(['config', 'user.name', 't'], source);
  fs.writeFileSync(path.join(source, 'f.txt'), 'v1\n');
  g(['add', '-A'], source);
  g(['commit', '-qm', 'init'], source);
  g(['remote', 'add', 'origin', remote], source);
  g(['push', '-q', '-u', 'origin', 'main'], source);
  return source;
}

test('start(): a file watched for the first time triggers no missed event (baseline only)', async () => {
  // Note: state.json shares the single XDG_STATE_HOME set at the top of this
  // file (paths.js fixes its values at import time); reflogTips keys are the
  // source repo's absolute path, so tests don't collide with each other.
  const { dir: root, cleanup: cleanupRoot } = tmpDir('updeps-watcher-catchup-');
  try {
    const source = makeSourceRepo(root);
    const config = resolveConfig({
      notifications: false,
      repos: [{ path: source, name: 'src', packages: [{ path: '/tmp/does-not-matter', name: 'tgt' }] }]
    });
    const events = [];
    const fakeQueue = { enqueue: (repo, event) => events.push(event) };

    const watcher = new ReflogWatcher(config, fakeQueue);
    watcher.start();
    await watcher.stop();

    assert.equal(events.length, 0);
  } finally {
    cleanupRoot();
  }
});

test('start(): a missed event is caught up when the recorded tip differs from the current one (a push happened while the daemon was down)', async () => {
  const { dir: root, cleanup: cleanupRoot } = tmpDir('updeps-watcher-catchup-');
  try {
    const source = makeSourceRepo(root);
    const config = resolveConfig({
      notifications: false,
      repos: [{ path: source, name: 'src', packages: [{ path: '/tmp/does-not-matter', name: 'tgt' }] }]
    });
    const events = [];
    const fakeQueue = { enqueue: (repo, event) => events.push(event) };

    // first daemon run: the baseline is recorded, no push yet
    const watcher1 = new ReflogWatcher(config, fakeQueue);
    watcher1.start();
    await watcher1.stop();
    assert.equal(events.length, 0);

    // one more push happens "while the daemon is down"
    fs.writeFileSync(path.join(source, 'f.txt'), 'v2\n');
    g(['commit', '-aqm', 'v2'], source);
    const sha = g(['rev-parse', 'HEAD'], source);
    g(['push', '-q', 'origin', 'main'], source);

    // the daemon restarts (reflogTips in state.json is preserved)
    const watcher2 = new ReflogWatcher(config, fakeQueue);
    watcher2.start();
    await watcher2.stop();

    assert.equal(events.length, 1);
    assert.equal(events[0].trigger, 'push');
    assert.equal(events[0].sha, sha);

    // on another restart with no push in between, it does not fire again
    const watcher3 = new ReflogWatcher(config, fakeQueue);
    watcher3.start();
    await watcher3.stop();
    assert.equal(events.length, 1);
  } finally {
    cleanupRoot();
  }
});
