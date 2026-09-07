import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acquireLock, getLockDirName } from '../src/lock.js';
import { LOCKS_DIR } from '../src/paths.js';

describe('Lock Mechanism', () => {
  it('generates consistent lock directory names', () => {
    const name1 = getLockDirName('/path/to/my-repo');
    const name2 = getLockDirName('/path/to/my-repo');
    assert.equal(name1, name2);
    assert.ok(name1.includes('my-repo'));
    assert.ok(name1.endsWith('.lock'));
  });

  it('acquires and releases atomic lock', async () => {
    const fakeRepo = path.join(os.tmpdir(), `sqaft-test-repo-${Date.now()}`);
    const lock = await acquireLock(fakeRepo, { waitTimeoutSec: 2 });

    assert.ok(lock);
    assert.ok(fs.existsSync(lock.lockPath));

    // Releasing lock should remove directory
    lock.release();
    assert.ok(!fs.existsSync(lock.lockPath));
  });

  it('detects and cleans stale locks', async () => {
    const fakeRepo = path.join(os.tmpdir(), `sqaft-stale-repo-${Date.now()}`);
    const lockDir = path.join(LOCKS_DIR, getLockDirName(fakeRepo));

    if (!fs.existsSync(LOCKS_DIR)) fs.mkdirSync(LOCKS_DIR, { recursive: true });
    fs.mkdirSync(lockDir, { recursive: true });

    // Set mtime to 1 hour ago
    const oneHourAgo = (Date.now() - 3600 * 1000) / 1000;
    fs.utimesSync(lockDir, oneHourAgo, oneHourAgo);

    // acquireLock with staleLockSec = 5 should reclaim it
    const lock = await acquireLock(fakeRepo, { staleLockSec: 5, waitTimeoutSec: 2 });
    assert.ok(lock);
    assert.ok(fs.existsSync(lock.lockPath));
    lock.release();
  });

  it('throws timeout error when waitTimeoutSec is positive and lock held', async () => {
    const fakeRepo = path.join(os.tmpdir(), `sqaft-timeout-repo-${Date.now()}`);
    const lock1 = await acquireLock(fakeRepo);

    await assert.rejects(
      () => acquireLock(fakeRepo, { waitTimeoutSec: 1 }),
      /Kilit alınamadı \(zaman aşımı: 1s\)/
    );

    lock1.release();
  });

  it('waits and acquires lock when released by previous holder with waitTimeoutSec: 0', async () => {
    const fakeRepo = path.join(os.tmpdir(), `sqaft-wait-repo-${Date.now()}`);
    const lock1 = await acquireLock(fakeRepo);

    let acquired2 = false;
    const promise2 = acquireLock(fakeRepo, { waitTimeoutSec: 0 }).then(l => {
      acquired2 = true;
      return l;
    });

    // Before release, lock2 should not have acquired
    await new Promise(r => setTimeout(r, 300));
    assert.equal(acquired2, false);

    // Release lock1
    lock1.release();

    const lock2 = await promise2;
    assert.equal(acquired2, true);
    assert.ok(lock2);
    lock2.release();
  });
});
