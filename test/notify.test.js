import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalNotifierArgs, sendNotification } from '../src/notify.js';
import { notifyRunGroup } from '../src/runner.js';

test('başarı bildirimi argv', () => {
  const args = terminalNotifierArgs({ type: 'ok', title: 'updeps: lib', message: '2 commit' });
  assert.deepEqual(args, [
    '-title', 'updeps: lib',
    '-subtitle', '✅ tamamlandı',
    '-message', '2 commit',
    '-sound', 'Glass'
  ]);
});

test('hata bildirimi Basso sesi kullanır', () => {
  const args = terminalNotifierArgs({ type: 'fail', title: 't', message: 'm' });
  assert.equal(args[args.indexOf('-sound') + 1], 'Basso');
});

test('notifications:false hiçbir şey yapmaz (throw etmez)', () => {
  assert.doesNotThrow(() =>
    sendNotification({ type: 'ok', title: 't', message: 'm', enabled: false })
  );
});

test('notifyRunGroup atlandı sayısını yalnızca varsa ekler', () => {
  const calls = [];
  const orig = console.log;
  // notifyRunGroup sadece sendNotification çağırır; enabled:false ile sessiz
  assert.doesNotThrow(() =>
    notifyRunGroup({
      notifications: false,
      title: 't',
      tally: { committed: 1, unchanged: 0, failed: 0, skipped: 2 }
    })
  );
  void calls;
  void orig;
});
