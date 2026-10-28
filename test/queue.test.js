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

test('jobs run one at a time, concurrency never exceeds 1', async () => {
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

test('debounce: consecutive events from the same source are merged', async () => {
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
  assert.equal(runs, 2); // two targets, one round
});

test('pending job merging: a shared target that is still queued runs once', async () => {
  // a -> one, two ; b -> two.  The first job (one) is slow; while two waits
  // in the queue, b's two job must merge into the existing pending job.
  const cfg = makeConfig();
  const targetsRun = [];
  const runner = async ({ target }) => {
    targetsRun.push(target.name);
    await sleep(60);
    return { status: 'committed', target: target.name, message: '' };
  };
  const q = new UpdateQueue(cfg, {
    runner
    // b is pointed at two below
  });
  cfg.repos[1].packages = [{ ...cfg.repos[0].packages[1] }]; // b -> two

  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'a1' });
  q.enqueue(cfg.repos[1], { trigger: 'push', branch: 'main', sha: 'b1' });

  while (!q.idle) await sleep(10);
  assert.equal(targetsRun.filter((n) => n === 'two').length, 1);
});

test('a new event for a running target is queued again after it finishes', async () => {
  const cfg = makeConfig();
  const targetsRun = [];
  let firstStarted;
  const runner = async ({ target }) => {
    targetsRun.push(target.name);
    if (targetsRun.length === 1) {
      firstStarted = true;
      await sleep(80); // b arrives while one is running
    }
    return { status: 'committed', target: target.name, message: '' };
  };
  cfg.repos[0].packages = [{ ...cfg.repos[0].packages[0] }]; // a -> one
  const q = new UpdateQueue(cfg, { runner });

  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'a1' });
  while (!firstStarted) await sleep(5);
  q.enqueue(cfg.repos[1], { trigger: 'push', branch: 'main', sha: 'b1' }); // b -> one, while it is running

  while (!q.idle) await sleep(10);
  assert.equal(targetsRun.filter((n) => n === 'one').length, 2);
});

test('coalesce:false (package setting) makes a shared target run twice', async () => {
  const cfg = makeConfig();
  cfg.repos[0].packages[0].coalesce = false; // turn it off for the 'one' target
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

test('coalesce is on by default (without a config override)', async () => {
  const cfg = makeConfig();
  assert.equal(cfg.repos[0].packages[0].coalesce, true);
});

test('targets resolved with different settings (execKey) do not merge, each runs with its own settings', async () => {
  // b's 'one' target has a different command (e.g. a different yarn command) —
  // merging it into a's pending job would run the wrong command. It must be a separate job.
  const cfg = makeConfig();
  cfg.repos[1].packages = [{ ...cfg.repos[0].packages[0], commands: ['echo different'] }];
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
    [['echo different'], cfg.repos[0].packages[0].commands].sort()
  );
});

test('a target rejected by the branch filter is skipped without ever entering the queue', async () => {
  const cfg = makeConfig();
  cfg.repos[1].packages[0] = { ...cfg.repos[1].packages[0], branches: ['develop'] };
  const runner = async ({ target }) => ({ status: 'committed', target: target.name, message: '' });
  const groups = [];
  const q = new UpdateQueue(cfg, { runner, onGroupDone: (g) => groups.push(g) });

  q.enqueue(cfg.repos[1], { trigger: 'push', branch: 'main', sha: 'b1' }); // 'one' has branches:['develop'] → rejected
  while (!q.idle) await sleep(10);
  await sleep(20);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].tally.skipped, 1);
  assert.equal(groups[0].tally.committed, 0);
});

test('{bumps} lists every source in a merged job', async () => {
  // 'two' runs first (slow) and holds the queued 'one' job back, so b's
  // 'one' trigger can merge into that not-yet-started job.
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

test('queued jobs show up in state.queue.jobs and drop out as they are processed', async () => {
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

test('if the config changes live, a queued job runs with the current target, not the old one', async () => {
  const cfg = resolveConfig({
    defaults: { debounceMs: 20 },
    repos: [
      {
        path: '/src/a',
        name: 'a',
        packages: [
          { path: '/tgt/two', name: 'two' },
          { path: '/tgt/one', name: 'one', commands: ['echo old'] }
        ]
      }
    ]
  });
  const seenCommands = [];
  const runner = async ({ target }) => {
    if (target.name === 'two') await sleep(40); // change the config while 'one' waits in the queue
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
          { path: '/tgt/one', name: 'one', commands: ['echo current'] }
        ]
      }
    ]
  });
  q.updateConfig(updated);

  while (!q.idle) await sleep(10);
  assert.deepEqual(seenCommands, [['echo current']]);
});

test('if the config changes live and a queued job\'s target was removed, it is skipped without running', async () => {
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
    repos: [{ path: '/src/a', name: 'a', packages: [{ path: '/tgt/two', name: 'two' }] }] // 'one' removed
  });
  q.updateConfig(updated);

  while (!q.idle) await sleep(10);
  assert.deepEqual(ran, ['two']); // 'one' never ran
});

test('shutdown: the active job is aborted and awaited, queued jobs are not rescheduled', async () => {
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
  await sleep(cfg.defaults.debounceMs + 10); // get past the debounce so the first job starts

  await q.shutdown(500);

  assert.equal(started.length, 1); // 'two' never started, it was dropped from the queue
  assert.equal(seenSignals[0], true); // the abort signal reached the running job
  assert.equal(q.ready.length, 0);
});

test('shutdown: a new enqueue is ignored (debounce timers are cleared)', async () => {
  const cfg = makeConfig();
  const runner = async () => ({ status: 'committed', target: 'x', message: '' });
  const q = new UpdateQueue(cfg, { runner });
  await q.shutdown();
  q.enqueue(cfg.repos[0], { trigger: 'push', branch: 'main', sha: 'a1' });
  await sleep(cfg.defaults.debounceMs + 20);
  assert.equal(q.ready.length, 0);
  assert.equal(q.groups.size, 0);
});

test('onGroupDone is called once when the group finishes', async () => {
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
