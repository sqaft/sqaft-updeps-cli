import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpDir } from './helpers.js';

const { dir, cleanup } = tmpDir('updeps-queue-');
process.env.XDG_STATE_HOME = dir;
process.env.XDG_CONFIG_HOME = dir;

const { UpdateQueue } = await import('../src/queue.js');
const { resolveConfig } = await import('../src/config.js');

// Each test starts from a clean state file so persisted lastProcessedSha values
// from one test don't dedup-skip the next.
test.beforeEach(() => {
  try {
    fs.rmSync(path.join(dir, 'sqaft-updeps', 'state.json'));
  } catch {
    /* none yet */
  }
});
test.after(cleanup);

function makeConfig(overrides = {}) {
  return resolveConfig({
    defaults: { debounceMs: 30, ...overrides },
    repos: [
      {
        path: '/src/a',
        name: 'a',
        packages: [
          { path: '/tgt/one', name: 'one' },
          { path: '/tgt/two', name: 'two' }
        ]
      },
      {
        path: '/src/b',
        name: 'b',
        packages: [{ path: '/tgt/one', name: 'one' }]
      }
    ]
  });
}

test('işler tek tek çalışır, eşzamanlılık asla 1\'i geçmez', async () => {
  const cfg = makeConfig();
  let active = 0;
  let maxActive = 0;
  const runner = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(20);
    active--;
    return { status: 'committed', target: 'x', message: '' };
  };

  const q = new UpdateQueue(cfg, { runner });
  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'a1' });
  q.enqueue(cfg.repos[1], { trigger: 'push', branch: 'main', sha: 'b1' });

  while (!q.idle) await sleep(10);
  assert.equal(maxActive, 1);
});

test('debounce: aynı kaynağın ardışık olayları birleşir', async () => {
  const cfg = makeConfig();
  let runs = 0;
  const runner = async () => {
    runs++;
    return { status: 'unchanged', target: 'x', message: '' };
  };
  const q = new UpdateQueue(cfg, { runner });
  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'a1' });
  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'a2' });
  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'a3' });

  while (!q.idle) await sleep(10);
  assert.equal(runs, 2); // iki hedef, tek tur
});

test('bekleyen iş birleştirme: hâlâ kuyruktaki ortak hedef tek kez çalışır', async () => {
  // a -> one, two ; b -> two.  İlk iş (one) yavaş; two kuyrukta beklerken
  // b'nin two işi mevcut bekleyen işe birleşmeli.
  const cfg = makeConfig();
  const targetsRun = [];
  const runner = async ({ target }) => {
    targetsRun.push(target.name);
    await sleep(60);
    return { status: 'committed', target: target.name, message: '' };
  };
  const q = new UpdateQueue(cfg, {
    runner,
    // b'yi two'ya bağla
  });
  cfg.repos[1].packages = [{ ...cfg.repos[0].packages[1] }]; // b -> two

  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'a1' });
  q.enqueue(cfg.repos[1], { trigger: 'push', branch: 'main', sha: 'b1' });

  while (!q.idle) await sleep(10);
  assert.equal(targetsRun.filter((n) => n === 'two').length, 1);
});

test('çalışan hedefe gelen yeni olay bittikten sonra yeniden kuyruğa alınır', async () => {
  const cfg = makeConfig();
  const targetsRun = [];
  let firstStarted;
  const runner = async ({ target }) => {
    targetsRun.push(target.name);
    if (targetsRun.length === 1) {
      firstStarted = true;
      await sleep(80); // one çalışırken b gelecek
    }
    return { status: 'committed', target: target.name, message: '' };
  };
  cfg.repos[0].packages = [{ ...cfg.repos[0].packages[0] }]; // a -> one
  const q = new UpdateQueue(cfg, { runner });

  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'a1' });
  while (!firstStarted) await sleep(5);
  q.enqueue(cfg.repos[1], { trigger: 'push', branch: 'main', sha: 'b1' }); // b -> one, çalışırken

  while (!q.idle) await sleep(10);
  assert.equal(targetsRun.filter((n) => n === 'one').length, 2);
});

test('coalesce:false ile ortak hedef iki kez çalışır', async () => {
  const cfg = makeConfig();
  const targetsRun = [];
  const runner = async ({ target }) => {
    targetsRun.push(target.name);
    return { status: 'committed', target: target.name, message: '' };
  };
  const q = new UpdateQueue(cfg, { runner, coalesce: false });
  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'a1' });
  q.enqueue(cfg.repos[1], { trigger: 'push', branch: 'main', sha: 'b1' });
  while (!q.idle) await sleep(10);
  assert.equal(targetsRun.filter((n) => n === 'one').length, 2);
});

test('grup bittiğinde onGroupDone bir kez çağrılır', async () => {
  const cfg = makeConfig();
  const groups = [];
  const q = new UpdateQueue(cfg, {
    runner: async () => ({ status: 'committed', target: 'x', message: '' }),
    onGroupDone: (g) => groups.push(g)
  });
  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'a1' });
  while (!q.idle) await sleep(10);
  await sleep(20);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].tally.committed, 2);
});
