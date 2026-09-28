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

test('config değişince onConfigChange tetiklenir — ardışık atomik yazmalarda da', async () => {
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
  assert.equal(reloads, 1, 'ilk değişiklik yeniden yükleme tetiklemeli');

  // Second write: the watch must still be live after the inode swap.
  saveConfig({ ...baseConfig(), notifications: false });
  for (let i = 0; i < 40 && reloads < 2; i++) await sleep(50);
  assert.equal(reloads, 2, 'ikinci değişiklik de tetiklenmeli');

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

test('start(): ilk kez izlenen dosyada kaçırılan olay tetiklenmez (yalnızca baseline)', async () => {
  // Not: state.json bu dosyanın tepesinde ayarlanan tek XDG_STATE_HOME'u
  // paylaşır (paths.js değerleri import anında sabitliyor); reflogTips
  // anahtarları source repo'nun mutlak yoluyla tutulduğu için testler
  // arasında çakışma olmaz.
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

test('start(): kayıtlı tip ile mevcut tip farklıysa (daemon kapalıyken push olmuş) kaçırılan olay yakalanır', async () => {
  const { dir: root, cleanup: cleanupRoot } = tmpDir('updeps-watcher-catchup-');
  try {
    const source = makeSourceRepo(root);
    const config = resolveConfig({
      notifications: false,
      repos: [{ path: source, name: 'src', packages: [{ path: '/tmp/does-not-matter', name: 'tgt' }] }]
    });
    const events = [];
    const fakeQueue = { enqueue: (repo, event) => events.push(event) };

    // ilk daemon çalışması: baseline yazılır, henüz push yok
    const watcher1 = new ReflogWatcher(config, fakeQueue);
    watcher1.start();
    await watcher1.stop();
    assert.equal(events.length, 0);

    // "daemon kapalıyken" bir push daha olur
    fs.writeFileSync(path.join(source, 'f.txt'), 'v2\n');
    g(['commit', '-aqm', 'v2'], source);
    const sha = g(['rev-parse', 'HEAD'], source);
    g(['push', '-q', 'origin', 'main'], source);

    // daemon yeniden başlar (state.json'daki reflogTips korunur)
    const watcher2 = new ReflogWatcher(config, fakeQueue);
    watcher2.start();
    await watcher2.stop();

    assert.equal(events.length, 1);
    assert.equal(events[0].trigger, 'push');
    assert.equal(events[0].sha, sha);

    // başka bir yeniden başlatmada, ara push olmadıysa tekrar tetiklenmez
    const watcher3 = new ReflogWatcher(config, fakeQueue);
    watcher3.start();
    await watcher3.stop();
    assert.equal(events.length, 1);
  } finally {
    cleanupRoot();
  }
});
