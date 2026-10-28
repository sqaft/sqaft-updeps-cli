import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { runShell, shellQuote, shellKind } from '../src/exec.js';
import { TEST_SHELL } from './helpers.js';

const isWindows = process.platform === 'win32';
const cwd = os.tmpdir();

test('runShell: on timeout grandchild processes are killed too and it returns without waiting for close', async () => {
  const marker = `updeps-exec-test-${process.pid}-${Date.now()}`;
  const start = Date.now();
  const result = await runShell(`sh -c 'sleep 6; echo ${marker}' `, { cwd, timeoutMs: 300, shell: TEST_SHELL });
  const elapsed = Date.now() - start;

  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 3000, `returned later than expected: ${elapsed}ms`);

  if (isWindows) return; // no `ps ax`; taskkill /T is what kills the tree there
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
  assert.equal(survivors.trim(), '', `orphaned process left behind: ${survivors}`);
});

test('runShell: exit code and stdout/stderr are captured', async () => {
  const result = await runShell('echo out; echo err 1>&2; exit 3', { cwd, timeoutMs: 5000, shell: TEST_SHELL });
  assert.equal(result.code, 3);
  assert.equal(result.stdout.trim(), 'out');
  assert.equal(result.stderr.trim(), 'err');
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
});

test('runShell: the Windows default shell is cmd.exe', { skip: !isWindows && 'Windows only' }, async () => {
  const result = await runShell('echo out& exit /b 3', { cwd, timeoutMs: 5000 });
  assert.equal(result.code, 3);
  assert.equal(result.stdout.trim(), 'out');
});

test('runShell: can be cancelled with an AbortSignal', async () => {
  const controller = new AbortController();
  const p = runShell('sleep 5', { cwd, timeoutMs: 10000, signal: controller.signal, shell: TEST_SHELL });
  setTimeout(() => controller.abort(), 100);
  const result = await p;
  assert.equal(result.aborted, true);
});

test('shellQuote: plain arguments and arguments with special characters', () => {
  assert.equal(shellQuote('abc'), 'abc');
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test('shellQuote: cmd.exe and PowerShell', () => {
  assert.equal(shellQuote('@acme/api', 'cmd'), '@acme/api');
  assert.equal(shellQuote('weird name', 'cmd'), '"weird name"');
  assert.equal(shellQuote('a"b', 'cmd'), '"a""b"');
  assert.equal(shellQuote('vendor/pkg', 'powershell'), 'vendor/pkg');
  // `@x` would be a splat in PowerShell
  assert.equal(shellQuote('@acme/api', 'powershell'), "'@acme/api'");
  assert.equal(shellQuote("it's", 'powershell'), "'it''s'");
});

test('shellKind: platform default, then the shell executable name', () => {
  assert.equal(shellKind(null), isWindows ? 'cmd' : 'posix');
  assert.equal(shellKind('/bin/bash'), 'posix');
  assert.equal(shellKind('C:\\Program Files\\Git\\bin\\bash.exe'), 'posix');
  assert.equal(shellKind('cmd.exe'), 'cmd');
  assert.equal(shellKind('C:\\Windows\\System32\\cmd.exe'), 'cmd');
  assert.equal(shellKind('pwsh'), 'powershell');
  assert.equal(shellKind('powershell.exe'), 'powershell');
  assert.equal(shellKind('/usr/local/bin/pwsh'), 'powershell');
});
