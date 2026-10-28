import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers.js';

const { dir, cleanup } = tmpDir('updeps-reset-');
process.env.XDG_STATE_HOME = dir;
process.env.XDG_CONFIG_HOME = dir;

const stateDir = path.join(dir, 'sqaft-updeps');
const configDir = path.join(dir, 'sqaft-updeps');

const { loadState, saveState, resetState } = await import('../src/state.js');
const { appendEvent } = await import('../src/journal.js');
const { cmdReset } = await import('../src/commands/reset.js');

test.after(cleanup);

function seed() {
  fs.mkdirSync(stateDir, { recursive: true });
  saveState({
    repos: { '/a': { lastProcessedSha: 'deadbeef' } },
    lastRuns: [{ timestamp: Date.now(), sourceRepo: 'a' }],
    openFailures: [{ id: 'x', source: 'a', target: 'b', message: 'boom' }],
    activeRun: { group: 'g1', source: 'a', target: 'b' },
    queue: { pending: 2, jobs: [{ target: 'b' }, { target: 'c' }] },
    daemon: { pid: 999999, startedAt: Date.now(), watchedRepos: 3 }
  });
  appendEvent({ kind: 'group_start', group: 'g1', source: 'a' });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'logs', 'updeps.log'), 'log line\n');
  fs.mkdirSync(path.join(stateDir, 'locks', 'b-abc123.lock'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), '{"keep":true}\n');
}

test('resetState empties the state; the daemon block is optionally kept', () => {
  seed();
  resetState();
  let s = loadState();
  assert.deepEqual(s.openFailures, []);
  assert.deepEqual(s.queue, { pending: 0, jobs: [] });
  assert.equal(s.activeRun, null);
  assert.deepEqual(s.repos, {});
  assert.equal(s.daemon, null);

  seed();
  resetState({ preserveDaemon: true });
  s = loadState();
  assert.equal(s.daemon.pid, 999999);
  assert.deepEqual(s.openFailures, []);
});

test('cmdReset --yes: clears everything except the config', async () => {
  seed();
  await cmdReset({ yes: true });

  const s = loadState();
  assert.deepEqual(s.openFailures, []);
  assert.deepEqual(s.queue, { pending: 0, jobs: [] });
  assert.deepEqual(s.repos, {});

  assert.ok(!fs.existsSync(path.join(stateDir, 'journal.jsonl')), 'journal should be deleted');
  assert.equal(fs.readFileSync(path.join(stateDir, 'logs', 'updeps.log'), 'utf8'), '', 'log should be truncated');
  assert.equal(fs.readdirSync(path.join(stateDir, 'locks')).length, 0, 'locks should be deleted');

  assert.equal(
    fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'),
    '{"keep":true}\n',
    'the config file should be untouched'
  );
});

test('cmdReset refuses without confirmation in a non-interactive environment', async () => {
  seed();
  const origExit = process.exit;
  const origTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  let exitCode;
  process.exit = (c) => {
    exitCode = c;
    throw new Error('exit');
  };
  try {
    await cmdReset({});
  } catch (err) {
    if (err.message !== 'exit') throw err;
  } finally {
    process.exit = origExit;
    if (origTTY) Object.defineProperty(process.stdin, 'isTTY', origTTY);
  }
  assert.equal(exitCode, 1);
  // nothing was deleted
  assert.ok(fs.existsSync(path.join(stateDir, 'journal.jsonl')));
});
