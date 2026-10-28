import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReflogLine, classifyReflogEvent } from '../src/reflog.js';

const SHA_A = '1111111111111111111111111111111111111111';
const SHA_B = '2222222222222222222222222222222222222222';

test('an author name containing spaces is parsed', () => {
  const line = `${SHA_A} ${SHA_B} Ada Lovelace <ada@ex.com> 1700000000 +0300\tupdate by push`;
  const p = parseReflogLine(line);
  assert.equal(p.oldSha, SHA_A);
  assert.equal(p.newSha, SHA_B);
  assert.equal(p.message, 'update by push');
});

test('null when there is no tab', () => {
  assert.equal(parseReflogLine('no tab here'), null);
});

test('push classification', () => {
  const p = parseReflogLine(`${SHA_A} ${SHA_B} X <x@x> 1700000000 +0000\tupdate by push`);
  const e = classifyReflogEvent('/repo/.git/logs/refs/remotes/origin/main', p);
  assert.deepEqual(e, { trigger: 'push', branch: 'main', remote: 'origin', sha: SHA_B });
});

test('fetch classification', () => {
  const p = parseReflogLine(`${SHA_A} ${SHA_B} X <x@x> 1700000000 +0000\tfetch origin: fast-forward`);
  const e = classifyReflogEvent('/repo/.git/logs/refs/remotes/origin/main', p);
  assert.equal(e.trigger, 'fetch');
});

test('commit classification (local heads)', () => {
  const p = parseReflogLine(`${SHA_A} ${SHA_B} X <x@x> 1700000000 +0000\tcommit: add feature`);
  const e = classifyReflogEvent('/repo/.git/logs/refs/heads/main', p);
  assert.equal(e.trigger, 'commit');
  assert.equal(e.branch, 'main');
});

test('merge/pull classification', () => {
  const p = parseReflogLine(`${SHA_A} ${SHA_B} X <x@x> 1700000000 +0000\tpull: Fast-forward`);
  const e = classifyReflogEvent('/repo/.git/logs/refs/heads/develop', p);
  assert.equal(e.trigger, 'merge');
});

test('git pull counts as a fetch in a remote-tracking reflog (not a push)', () => {
  const p1 = parseReflogLine(`${SHA_A} ${SHA_B} X <x@x> 1700000000 +0000\tpull -q origin main: storing head`);
  const e1 = classifyReflogEvent('/repo/.git/logs/refs/remotes/origin/main', p1);
  assert.equal(e1.trigger, 'fetch');

  const p2 = parseReflogLine(`${SHA_A} ${SHA_B} X <x@x> 1700000000 +0000\tpull -q: fast-forward`);
  const e2 = classifyReflogEvent('/repo/.git/logs/refs/remotes/origin/main', p2);
  assert.equal(e2.trigger, 'fetch');
});

test('an unrecognized remote-tracking message is not assumed to be a push, it is ignored', () => {
  const p = parseReflogLine(`${SHA_A} ${SHA_B} X <x@x> 1700000000 +0000\tsome unrelated ref-update`);
  const e = classifyReflogEvent('/repo/.git/logs/refs/remotes/origin/main', p);
  assert.equal(e, null);
});

test('a branch name containing a slash', () => {
  const p = parseReflogLine(`${SHA_A} ${SHA_B} X <x@x> 1700000000 +0000\tupdate by push`);
  const e = classifyReflogEvent('/repo/.git/logs/refs/remotes/origin/feature/x', p);
  assert.equal(e.branch, 'feature/x');
});
