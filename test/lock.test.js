import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpDir } from './helpers.js';

const { dir, cleanup } = tmpDir('updeps-lock-');
process.env.XDG_STATE_HOME = dir;
process.env.XDG_CONFIG_HOME = dir;

const { acquireLock, lockNameFor } = await import('../src/lock.js');

test.after(cleanup);

test('kilit alınır ve bırakılır', async () => {
  const lock = await acquireLock('/repo/x', { waitTimeoutSec: 2 });
  assert.ok(fs.existsSync(lock.lockPath));
  lock.release();
  assert.ok(!fs.existsSync(lock.lockPath));
});

test('aynı repo ikinci kez alınamaz, timeout atar', async () => {
  const lock = await acquireLock('/repo/y', { waitTimeoutSec: 2 });
  await assert.rejects(
    () => acquireLock('/repo/y', { waitTimeoutSec: 1 }),
    /zaman aşımı/
  );
  lock.release();
});

test('bayat kilit çalınır', async () => {
  const lockPath = `${dir}/locks/${lockNameFor('/repo/z')}`;
  fs.mkdirSync(lockPath, { recursive: true });
  const old = Date.now() / 1000 - 1000;
  fs.utimesSync(lockPath, old, old);

  const lock = await acquireLock('/repo/z', { staleLockSec: 900, waitTimeoutSec: 3 });
  assert.ok(fs.existsSync(lock.lockPath));
  lock.release();
});

test('farklı repolar bağımsız', async () => {
  const a = await acquireLock('/repo/a', { waitTimeoutSec: 2 });
  const b = await acquireLock('/repo/b', { waitTimeoutSec: 2 });
  a.release();
  b.release();
  assert.ok(true);
});
