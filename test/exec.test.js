import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { runShell, shellQuote } from '../src/exec.js';

test('runShell: zaman aşımında torun süreçler de öldürülür, close beklenmeden döner', async () => {
  const marker = `updeps-exec-test-${process.pid}-${Date.now()}`;
  const start = Date.now();
  const result = await runShell(`sh -c 'sleep 6; echo ${marker}' `, { cwd: '/tmp', timeoutMs: 300 });
  const elapsed = Date.now() - start;

  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 3000, `beklenenden geç döndü: ${elapsed}ms`);

  // give the OS a moment to reap, then confirm no `sleep 6` survives (the pgrep
  // invocation itself also matches the marker string, so match on `sleep` instead)
  await new Promise((r) => setTimeout(r, 200));
  let survivors = '';
  try {
    // bracket trick so the grep/pgrep invocation's own argv doesn't self-match
    survivors = execSync(`ps ax | grep '[s]leep 6' || true`, { encoding: 'utf8' });
  } catch {
    /* pgrep not available on this platform — skip the assertion below */
  }
  assert.equal(survivors.trim(), '', `yetim süreç kaldı: ${survivors}`);
});

test('runShell: normal çıkış kodu ve stdout/stderr yakalanır', async () => {
  const result = await runShell('echo out; echo err 1>&2; exit 3', { cwd: '/tmp', timeoutMs: 5000 });
  assert.equal(result.code, 3);
  assert.equal(result.stdout.trim(), 'out');
  assert.equal(result.stderr.trim(), 'err');
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
});

test('runShell: AbortSignal ile iptal edilir', async () => {
  const controller = new AbortController();
  const p = runShell('sleep 5', { cwd: '/tmp', timeoutMs: 10000, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const result = await p;
  assert.equal(result.aborted, true);
});

test('shellQuote: basit ve özel karakterli argümanlar', () => {
  assert.equal(shellQuote('abc'), 'abc');
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});
