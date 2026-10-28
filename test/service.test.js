import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers.js';

const { dir, cleanup } = tmpDir('updeps-service-');
process.env.XDG_STATE_HOME = path.join(dir, 'state');
process.env.XDG_CONFIG_HOME = path.join(dir, 'config');

const { BIN_PATH } = await import('../src/launcher.js');
const { renderUnit, parseUnit, inspect: inspectUnit } = await import('../src/service/systemd.js');
const { renderStartupScript, parseStartupScript, inspect: inspectStartupScript } = await import(
  '../src/service/startup.js'
);
const { startControlServer, sendControl } = await import('../src/control.js');
const supervised = await import('../src/service/supervised.js');
const { runningDaemonPid, runningSupervisorPid } = await import('../src/daemon.js');
const { loadState } = await import('../src/state.js');
const { CONFIG_FILE } = await import('../src/paths.js');

const isWindows = process.platform === 'win32';
const D = path.delimiter;

test.after(async () => {
  await supervised.stop();
  cleanup();
});

/** Runs `fn` with process.env.PATH set to `value`. */
function withPath(value, fn) {
  const saved = process.env.PATH;
  process.env.PATH = value;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

const nodeDir = path.dirname(process.execPath);
const oddDir = isWindows ? 'C:\\odd 100%\\$HOME\\a"b' : '/odd 100%/$HOME/a"b\\c';

test('systemd: renderUnit runs node through env with the launch PATH, and parseUnit reads it back', () => {
  const unit = withPath([oddDir, nodeDir].join(D), () => renderUnit());
  assert.match(unit, /^ExecStart=\/usr\/bin\/env node ".*updeps\.js" daemon$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartPreventExitStatus=3$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  // `%` is a unit specifier and must be doubled
  assert.ok(unit.includes('100%%'));

  assert.deepEqual(parseUnit(unit), { node: 'node', bin: BIN_PATH, path: [oddDir, nodeDir].join(D) });
});

test('systemd: parseUnit handles an absolute Node path and a missing ExecStart', () => {
  assert.deepEqual(parseUnit('[Service]\nExecStart=/opt/node/bin/node /x/updeps.js daemon\n'), {
    node: '/opt/node/bin/node',
    bin: '/x/updeps.js',
    path: null
  });
  assert.equal(parseUnit('[Service]\nType=simple\n'), null);
});

test('systemd: inspect reports not installed, unreadable and a resolvable Node', () => {
  assert.equal(inspectUnit(path.join(dir, 'missing.service')).installed, false);

  const broken = path.join(dir, 'broken.service');
  fs.writeFileSync(broken, '[Service]\n');
  const res = inspectUnit(broken);
  assert.equal(res.installed, true);
  assert.ok(res.error);

  const file = path.join(dir, 'ok.service');
  fs.writeFileSync(file, withPath(nodeDir, () => renderUnit()));
  const ok = inspectUnit(file);
  assert.equal(ok.error, null);
  assert.equal(ok.bin, BIN_PATH);
  assert.equal(ok.problem, null);
  assert.ok(ok.nodeVersion?.startsWith('v'));
});

test('startup script: CRLF batch file with the launch PATH, `%` escaped, read back by parseStartupScript', () => {
  const script = withPath([oddDir.replace(/"/g, ''), nodeDir].join(D), () => renderStartupScript());
  assert.ok(script.startsWith('@echo off\r\n'));
  assert.ok(script.includes('\r\nset "PATH='));
  assert.ok(script.includes('100%%'));
  assert.match(script, /\r\nnode ".*updeps\.js" daemon --detach\r\n$/);

  assert.deepEqual(parseStartupScript(script), {
    node: 'node',
    bin: BIN_PATH,
    path: [oddDir.replace(/"/g, ''), nodeDir].join(D)
  });
  assert.equal(parseStartupScript('@echo off\r\necho hi\r\n'), null);
});

test('startup script: inspect resolves node from the saved PATH', () => {
  assert.equal(inspectStartupScript(path.join(dir, 'missing.cmd')).installed, false);
  const file = path.join(dir, 'updeps.cmd');
  fs.writeFileSync(file, withPath(nodeDir, () => renderStartupScript()));
  const res = inspectStartupScript(file);
  assert.equal(res.installed, true);
  assert.equal(res.bin, BIN_PATH);
  assert.equal(res.problem, null);
});

const testAddress = isWindows
  ? `\\\\.\\pipe\\updeps-test-${process.pid}`
  : path.join(dir, 'ctl.sock');

test('control channel: replies to known commands, rejects unknown ones, null when nobody listens', async () => {
  assert.equal(await sendControl('ping', { address: testAddress, timeoutMs: 1000 }), null);

  let shutdowns = 0;
  const server = await startControlServer(
    {
      ping: () => ({ pid: 42 }),
      shutdown: async () => {
        shutdowns++;
        return {};
      }
    },
    testAddress
  );
  try {
    assert.deepEqual(await sendControl('ping', { address: testAddress }), { ok: true, pid: 42 });
    assert.deepEqual(await sendControl('shutdown', { address: testAddress }), { ok: true });
    assert.equal(shutdowns, 1);
    const unknown = await sendControl('toString', { address: testAddress });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /unknown command/);
  } finally {
    server.close();
  }
});

test('supervisor: starts the daemon in the background, restarts it after a crash, stops it over the control channel', async () => {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ notifications: false, repos: [] }));

  await supervised.start();
  const firstPid = runningDaemonPid();
  assert.ok(firstPid, 'daemon is running');
  assert.ok(runningSupervisorPid(), 'supervisor is running');
  assert.equal(loadState().daemon?.pid, firstPid);
  assert.equal((await sendControl('ping'))?.pid, firstPid);

  // a crash (hard kill) is restarted by the supervisor
  process.kill(firstPid, 'SIGKILL');
  const restarted = await supervised.waitUntil(() => {
    const pid = runningDaemonPid();
    return pid !== null && pid !== firstPid;
  }, 15_000);
  assert.ok(restarted, 'the supervisor started a new daemon');
  assert.equal(await supervised.waitForDaemon(10_000), runningDaemonPid());

  await supervised.stop();
  assert.equal(runningDaemonPid(), null);
  assert.equal(runningSupervisorPid(), null);
  assert.equal(loadState().daemon, null);
});
