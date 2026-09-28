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

test('coalesce:false (paket ayarı) ile ortak hedef iki kez çalışır', async () => {
  const cfg = makeConfig();
  cfg.repos[0].packages[0].coalesce = false; // 'one' hedefi için kapat
  cfg.repos[1].packages[0].coalesce = false;
  const targetsRun = [];
  const runner = async ({ target }) => {
    targetsRun.push(target.name);
    return { status: 'committed', target: target.name, message: '' };
  };
  const q = new UpdateQueue(cfg, { runner });
  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'a1' });
  q.enqueue(cfg.repos[1], { trigger: 'push', branch: 'main', sha: 'b1' });
  while (!q.idle) await sleep(10);
  assert.equal(targetsRun.filter((n) => n === 'one').length, 2);
});

test('varsayılan olarak coalesce açıktır (config override yoksa)', async () => {
  const cfg = makeConfig();
  assert.equal(cfg.repos[0].packages[0].coalesce, true);
});

test('farklı çözülmüş hedef ayarları (execKey) birleşmez, her biri kendi ayarıyla çalışır', async () => {
  // b'nin 'one' hedefi farklı bir komuta sahip (örn. farklı bir yarn komutu) —
  // a'nın bekleyen işine birleşirse yanlış komut çalışır. Ayrı iş olmalı.
  const cfg = makeConfig();
  cfg.repos[1].packages = [{ ...cfg.repos[0].packages[0], commands: ['echo farklı'] }];
  const runs = [];
  const runner = async ({ target }) => {
    runs.push({ name: target.name, commands: target.commands });
    await sleep(20);
    return { status: 'committed', target: target.name, message: '' };
  };
  const q = new UpdateQueue(cfg, { runner });
  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'a1' });
  q.enqueue(cfg.repos[1], { trigger: 'push', branch: 'main', sha: 'b1' });
  while (!q.idle) await sleep(10);

  const oneRuns = runs.filter((r) => r.name === 'one');
  assert.equal(oneRuns.length, 2);
  assert.deepEqual(
    oneRuns.map((r) => r.commands).sort(),
    [['echo farklı'], cfg.repos[0].packages[0].commands].sort()
  );
});

test('branch filtresine takılan kaynak hedefi kuyruğa hiç girmeden atlanır', async () => {
  const cfg = makeConfig();
  cfg.repos[1].packages[0] = { ...cfg.repos[1].packages[0], branches: ['develop'] };
  const runner = async ({ target }) => ({ status: 'committed', target: target.name, message: '' });
  const groups = [];
  const q = new UpdateQueue(cfg, { runner, onGroupDone: (g) => groups.push(g) });

  q.enqueue(cfg.repos[1], { trigger: 'push', branch: 'main', sha: 'b1' }); // 'one' branches:['develop'] → reddedilir
  while (!q.idle) await sleep(10);
  await sleep(20);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].tally.skipped, 1);
  assert.equal(groups[0].tally.committed, 0);
});

test('birleşen işte {bumps} tüm kaynakları listeler', async () => {
  // 'two' önce çalışacak (yavaş) ve kuyruktaki 'one' işini beklemede tutacak,
  // böylece b'nin 'one' tetikleyicisi henüz başlamamış o işe birleşebilir.
  const { interpolateMessage } = await import('../src/template.js');
  const cfg = resolveConfig({
    defaults: { debounceMs: 20 },
    repos: [
      {
        path: '/src/a',
        name: 'a',
        packages: [
          { path: '/tgt/two', name: 'two' },
          { path: '/tgt/one', name: 'one' }
        ]
      },
      { path: '/src/b', name: 'b', packages: [{ path: '/tgt/one', name: 'one' }] }
    ]
  });
  let capturedTrigger;
  const runner = async ({ target, trigger }) => {
    if (target.name === 'two') await sleep(60);
    else capturedTrigger = trigger;
    return { status: 'committed', target: target.name, message: '' };
  };
  const q = new UpdateQueue(cfg, { runner });
  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  q.enqueue(cfg.repos[1], { trigger: 'push', branch: 'main', sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
  while (!q.idle) await sleep(10);

  assert.equal(capturedTrigger.sources.length, 2);
  const bumps = interpolateMessage('{bumps}', {
    pkg: capturedTrigger.sourceName,
    sha: capturedTrigger.sha,
    sources: capturedTrigger.sources
  });
  assert.equal(bumps, 'a@aaaaaaa, b@bbbbbbb');
});

test('kuyruktaki işler state.queue.jobs\'ta görünür ve işlendikçe düşer', async () => {
  const { loadState } = await import('../src/state.js');
  const cfg = makeConfig();
  const seen = [];
  const runner = async ({ target }) => {
    seen.push(loadState().queue.jobs.map((j) => j.target).sort());
    await sleep(20);
    return { status: 'committed', target: target.name, message: '' };
  };
  const q = new UpdateQueue(cfg, { runner });
  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'a1' }); // -> one, two

  while (!q.idle) await sleep(10);

  // while the first target ran, the other was still queued; by the last it was empty
  assert.deepEqual(seen[0], ['two']);
  assert.deepEqual(seen[1], []);
  assert.deepEqual(loadState().queue, { pending: 0, jobs: [] });
});

test('config canlı değişirse kuyruktaki iş eski değil güncel hedefle çalışır', async () => {
  const cfg = resolveConfig({
    defaults: { debounceMs: 20 },
    repos: [
      {
        path: '/src/a',
        name: 'a',
        packages: [
          { path: '/tgt/two', name: 'two' },
          { path: '/tgt/one', name: 'one', commands: ['echo eski'] }
        ]
      }
    ]
  });
  const seenCommands = [];
  const runner = async ({ target }) => {
    if (target.name === 'two') await sleep(40); // 'one' kuyrukta beklerken config değiştir
    else seenCommands.push(target.commands);
    return { status: 'committed', target: target.name, message: '' };
  };
  const q = new UpdateQueue(cfg, { runner });
  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'a1' });
  await sleep(10);

  const updated = resolveConfig({
    defaults: { debounceMs: 20 },
    repos: [
      {
        path: '/src/a',
        name: 'a',
        packages: [
          { path: '/tgt/two', name: 'two' },
          { path: '/tgt/one', name: 'one', commands: ['echo güncel'] }
        ]
      }
    ]
  });
  q.updateConfig(updated);

  while (!q.idle) await sleep(10);
  assert.deepEqual(seenCommands, [['echo güncel']]);
});

test('config canlı değişirse kuyruktaki iş hedefi kaldırılmışsa çalıştırılmadan atlanır', async () => {
  const cfg = resolveConfig({
    defaults: { debounceMs: 20 },
    repos: [
      {
        path: '/src/a',
        name: 'a',
        packages: [
          { path: '/tgt/two', name: 'two' },
          { path: '/tgt/one', name: 'one' }
        ]
      }
    ]
  });
  const ran = [];
  const runner = async ({ target }) => {
    if (target.name === 'two') await sleep(40);
    ran.push(target.name);
    return { status: 'committed', target: target.name, message: '' };
  };
  const q = new UpdateQueue(cfg, { runner });
  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'a1' });
  await sleep(10);

  const updated = resolveConfig({
    defaults: { debounceMs: 20 },
    repos: [{ path: '/src/a', name: 'a', packages: [{ path: '/tgt/two', name: 'two' }] }] // 'one' kaldırıldı
  });
  q.updateConfig(updated);

  while (!q.idle) await sleep(10);
  assert.deepEqual(ran, ['two']); // 'one' hiç çalıştırılmadı
});

test('shutdown: aktif iş abort edilir ve beklenir, kuyruktaki bekleyenler yeniden zamanlanmaz', async () => {
  const cfg = makeConfig();
  const seenSignals = [];
  const started = [];
  const runner = async ({ target, signal }) => {
    started.push(target.name);
    await sleep(30);
    seenSignals.push(signal?.aborted ?? null);
    return { status: signal?.aborted ? 'failed' : 'committed', target: target.name, message: '' };
  };
  const q = new UpdateQueue(cfg, { runner });
  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'a1' }); // -> one, two
  await sleep(cfg.defaults.debounceMs + 10); // debounce'ı geçir, ilk iş başlasın

  await q.shutdown(500);

  assert.equal(started.length, 1); // 'two' hiç başlamadı, kuyruktan düşürüldü
  assert.equal(seenSignals[0], true); // çalışan işe abort sinyali ulaştı
  assert.equal(q.ready.length, 0);
});

test('shutdown: yeni enqueue işlenmez (debounce zamanlayıcıları temizlenir)', async () => {
  const cfg = makeConfig();
  const runner = async () => ({ status: 'committed', target: 'x', message: '' });
  const q = new UpdateQueue(cfg, { runner });
  await q.shutdown();
  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'a1' });
  await sleep(cfg.defaults.debounceMs + 20);
  assert.equal(q.ready.length, 0);
  assert.equal(q.groups.size, 0);
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
