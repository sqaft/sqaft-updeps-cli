import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpDir } from './helpers.js';

const { dir, cleanup } = tmpDir('updeps-lock-');
process.env.XDG_STATE_HOME = dir;
process.env.XDG_CONFIG_HOME = dir;

const { acquireLock, lockNameFor, releaseHeldLocks } = await import('../src/lock.js');

test.after(cleanup);

test('a lock is acquired and released', async () => {
  const lock = await acquireLock('/repo/x', { waitTimeoutSec: 2 });
  assert.ok(fs.existsSync(lock.lockPath));
  lock.release();
  assert.ok(!fs.existsSync(lock.lockPath));
});

test('the same repo cannot be locked twice, it times out', async () => {
  const lock = await acquireLock('/repo/y', { waitTimeoutSec: 2 });
  await assert.rejects(
    () => acquireLock('/repo/y', { waitTimeoutSec: 1 }),
    /timed out/
  );
  lock.release();
});

test('a stale lock is taken over', async () => {
  const lockPath = `${dir}/locks/${lockNameFor('/repo/z')}`;
  fs.mkdirSync(lockPath, { recursive: true });
  const old = Date.now() / 1000 - 1000;
  fs.utimesSync(lockPath, old, old);

  const lock = await acquireLock('/repo/z', { staleLockSec: 900, waitTimeoutSec: 3 });
  assert.ok(fs.existsSync(lock.lockPath));
  lock.release();
});

test('different repos are independent', async () => {
  const a = await acquireLock('/repo/a', { waitTimeoutSec: 2 });
  const b = await acquireLock('/repo/b', { waitTimeoutSec: 2 });
  a.release();
  b.release();
  assert.ok(true);
});

test('a lock whose owner is dead is reclaimed without waiting', async () => {
  const lockPath = `${dir}/locks/${lockNameFor('/repo/dead')}`;
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(
    `${lockPath}/info.json`,
    JSON.stringify({ pid: 2147483646, repoPath: '/repo/dead', acquiredAt: Date.now() })
  );

  const start = Date.now();
  const lock = await acquireLock('/repo/dead', { staleLockSec: 900, waitTimeoutSec: 3 });
  assert.ok(Date.now() - start < 1500, 'a lock with a dead owner should be acquired immediately');
  assert.ok(fs.existsSync(lock.lockPath));
  lock.release();
});

test('a lock with a live owner is not reclaimed', async () => {
  const held = await acquireLock('/repo/live', { waitTimeoutSec: 2 });
  await assert.rejects(
    () => acquireLock('/repo/live', { waitTimeoutSec: 1 }),
    /timed out/
  );
  held.release();
});

test('releaseHeldLocks removes every held lock', async () => {
  const l1 = await acquireLock('/repo/h1', { waitTimeoutSec: 2 });
  const l2 = await acquireLock('/repo/h2', { waitTimeoutSec: 2 });
  releaseHeldLocks();
  assert.ok(!fs.existsSync(l1.lockPath));
  assert.ok(!fs.existsSync(l2.lockPath));
});
