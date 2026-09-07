import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers.js';

const { dir, cleanup } = tmpDir('updeps-journal-');
process.env.XDG_STATE_HOME = dir;
process.env.XDG_CONFIG_HOME = dir;

const { appendEvent, readEvents, parseSince } = await import('../src/journal.js');

test.beforeEach(() => {
  try {
    fs.rmSync(path.join(dir, 'sqaft-updeps', 'journal.jsonl'));
  } catch {
    /* none */
  }
});
test.after(cleanup);

test('append + read newest-first, ts eklenir', () => {
  appendEvent({ kind: 'target', target: 'a', status: 'committed' });
  appendEvent({ kind: 'target', target: 'b', status: 'failed' });
  const events = readEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0].target, 'b');
  assert.ok(events[0].ts);
});

test('filter ve limit', () => {
  for (let i = 0; i < 10; i++) {
    appendEvent({ kind: 'target', target: `t${i}`, status: i % 2 ? 'failed' : 'committed' });
  }
  const failed = readEvents({ filter: (r) => r.status === 'failed' });
  assert.equal(failed.length, 5);
  const limited = readEvents({ limit: 3 });
  assert.equal(limited.length, 3);
});

test('bozuk satır atlanır', () => {
  appendEvent({ kind: 'target', target: 'ok' });
  fs.appendFileSync(path.join(dir, 'sqaft-updeps', 'journal.jsonl'), '{bozuk\n');
  appendEvent({ kind: 'target', target: 'ok2' });
  const events = readEvents();
  assert.deepEqual(events.map((e) => e.target), ['ok2', 'ok']);
});

test('parseSince göreli ve ISO', () => {
  const now = Date.now();
  assert.ok(Math.abs(parseSince('1h') - (now - 3600_000)) < 2000);
  assert.ok(Math.abs(parseSince('2d') - (now - 172800_000)) < 2000);
  assert.equal(parseSince('2026-01-01'), Date.parse('2026-01-01'));
  assert.equal(parseSince('çöp'), 0);
});
