import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReflogLine, classifyReflogEvent } from '../src/reflog.js';

const SHA_A = '1111111111111111111111111111111111111111';
const SHA_B = '2222222222222222222222222222222222222222';

test('boşluklu yazar adı ayrıştırılır', () => {
  const line = `${SHA_A} ${SHA_B} Ada Lovelace <ada@ex.com> 1700000000 +0300\tupdate by push`;
  const p = parseReflogLine(line);
  assert.equal(p.oldSha, SHA_A);
  assert.equal(p.newSha, SHA_B);
  assert.equal(p.message, 'update by push');
});

test('tab yoksa null', () => {
  assert.equal(parseReflogLine('no tab here'), null);
});

test('push sınıflandırması', () => {
  const p = parseReflogLine(`${SHA_A} ${SHA_B} X <x@x> 1700000000 +0000\tupdate by push`);
  const e = classifyReflogEvent('/repo/.git/logs/refs/remotes/origin/main', p);
  assert.deepEqual(e, { trigger: 'push', branch: 'main', remote: 'origin', sha: SHA_B });
});

test('fetch sınıflandırması', () => {
  const p = parseReflogLine(`${SHA_A} ${SHA_B} X <x@x> 1700000000 +0000\tfetch origin: fast-forward`);
  const e = classifyReflogEvent('/repo/.git/logs/refs/remotes/origin/main', p);
  assert.equal(e.trigger, 'fetch');
});

test('commit sınıflandırması (local heads)', () => {
  const p = parseReflogLine(`${SHA_A} ${SHA_B} X <x@x> 1700000000 +0000\tcommit: add feature`);
  const e = classifyReflogEvent('/repo/.git/logs/refs/heads/main', p);
  assert.equal(e.trigger, 'commit');
  assert.equal(e.branch, 'main');
});

test('merge/pull sınıflandırması', () => {
  const p = parseReflogLine(`${SHA_A} ${SHA_B} X <x@x> 1700000000 +0000\tpull: Fast-forward`);
  const e = classifyReflogEvent('/repo/.git/logs/refs/heads/develop', p);
  assert.equal(e.trigger, 'merge');
});

test('slash içeren branch adı', () => {
  const p = parseReflogLine(`${SHA_A} ${SHA_B} X <x@x> 1700000000 +0000\tupdate by push`);
  const e = classifyReflogEvent('/repo/.git/logs/refs/remotes/origin/feature/x', p);
  assert.equal(e.branch, 'feature/x');
});
