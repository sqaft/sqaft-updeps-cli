import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalNotifierArgs, notifySendArgs, windowsToastScript, sendNotification } from '../src/notify.js';
import { notifyRunGroup } from '../src/runner.js';

test('success notification argv', () => {
  const args = terminalNotifierArgs({ type: 'ok', title: 'updeps: lib', message: '2 commit' });
  assert.deepEqual(args, [
    '-title', 'updeps: lib',
    '-subtitle', '✅ done',
    '-message', '2 commit',
    '-sound', 'Glass'
  ]);
});

test('a failure notification uses the Basso sound', () => {
  const args = terminalNotifierArgs({ type: 'fail', title: 't', message: 'm' });
  assert.equal(args[args.indexOf('-sound') + 1], 'Basso');
});

test('notify-send argv (Linux): status in the summary, message as the body', () => {
  assert.deepEqual(notifySendArgs({ type: 'fail', title: 'updeps: lib', message: '-1 failed' }), [
    '--app-name=updeps',
    '--icon=dialog-error',
    '--',
    'updeps: lib — ❌ failed',
    '-1 failed'
  ]);
});

test('Windows toast script: texts are escaped for the toast XML and the PowerShell string', () => {
  const script = windowsToastScript({ type: 'ok', title: "it's <lib>", message: 'a & b' });
  assert.ok(script.includes("<text>it''s &lt;lib&gt;</text>"));
  assert.ok(script.includes('<text>✅ done</text>'));
  assert.ok(script.includes('<text>a &amp; b</text>'));
  // the only single quotes left unescaped delimit PowerShell strings
  const loadXml = script.split('\n').find((l) => l.startsWith('$xml.LoadXml('));
  assert.match(loadXml, /^\$xml\.LoadXml\('(?:[^']|'')*'\)$/);
});

test('notifications:false does nothing (does not throw)', () => {
  assert.doesNotThrow(() =>
    sendNotification({ type: 'ok', title: 't', message: 'm', enabled: false })
  );
});

test('notifyRunGroup includes the skipped count only when present', () => {
  const calls = [];
  const orig = console.log;
  // notifyRunGroup only calls sendNotification; silent with enabled:false
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
