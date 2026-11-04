import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpDir } from './helpers.js';

const { dir, cleanup } = tmpDir('updeps-notices-');
process.env.XDG_STATE_HOME = path.join(dir, 'state');
process.env.XDG_CONFIG_HOME = path.join(dir, 'config');
process.env.XDG_DATA_HOME = path.join(dir, 'data');

const { noticesEnabled, afterCommand } = await import('../src/notices.js');
const { BIN_PATH } = await import('../src/launcher.js');

test.after(cleanup);

const ALL_TTY = { stdin: true, stdout: true, stderr: true };

test('noticesEnabled: shown for an interactive command in a terminal', () => {
  for (const command of ['list', 'status', 'history', 'gui', 'run']) {
    assert.equal(noticesEnabled({ command, values: {}, env: {}, tty: ALL_TTY }), true, command);
  }
  assert.equal(noticesEnabled({ command: 'status', values: { watch: false, json: undefined }, env: {}, tty: ALL_TTY }), true);
});

test('noticesEnabled: every non-interactive situation turns them off', () => {
  const base = { command: 'list', values: {}, env: {}, tty: ALL_TTY };
  assert.equal(noticesEnabled(base), true);

  assert.equal(noticesEnabled({ ...base, tty: { ...ALL_TTY, stdin: false } }), false, 'stdin is not a terminal');
  assert.equal(noticesEnabled({ ...base, tty: { ...ALL_TTY, stdout: false } }), false, 'stdout is not a terminal');
  assert.equal(noticesEnabled({ ...base, tty: { ...ALL_TTY, stderr: false } }), false, 'stderr is not a terminal');
  assert.equal(noticesEnabled({ ...base, env: { UPDEPS_NO_NOTICES: '1' } }), false, 'UPDEPS_NO_NOTICES');
  assert.equal(noticesEnabled({ ...base, command: 'daemon' }), false, 'daemon');
  assert.equal(noticesEnabled({ ...base, values: { json: true } }), false, '--json');
  assert.equal(noticesEnabled({ ...base, values: { watch: true } }), false, '--watch');
  assert.equal(noticesEnabled({ ...base, values: { follow: true } }), false, '--follow');
  // An empty variable counts as unset.
  assert.equal(noticesEnabled({ ...base, env: { UPDEPS_NO_NOTICES: '' } }), true);
});

/** The deps of a notices run where nothing touches the machine; `log` records what happened. */
function fakeDeps(overrides = {}) {
  const log = { printed: [], asked: [], snoozed: [], installs: 0, restarts: 0 };
  const cli = { current: '0.2.0', latest: '0.3.0', update: true, command: 'npm install -g @sqaft/updeps-cli' };
  const deps = {
    env: {},
    tty: ALL_TTY,
    print: (line) => log.printed.push(line.replace(/\x1b\[\d+m/g, '')),
    ask: async (question) => (log.asked.push(question), true),
    now: () => 1_000,
    findApp: () => ({ version: '1.0.0' }),
    checkUpdates: async () => ({ cli, app: { latest: null } }),
    isSnoozed: () => false,
    snoozeVersion: (version, now) => log.snoozed.push([version, now]),
    installCli: () => (log.installs++, { status: 0 }),
    readInstalledVersion: () => '0.3.0',
    daemonPid: () => null,
    daemonBusy: () => false,
    restartDaemon: () => (log.restarts++, { status: 0 }),
    ...overrides
  };
  return { deps, log, cli };
}

test('afterCommand: does nothing when the notices are off', async () => {
  const { deps, log } = fakeDeps({
    findApp: () => null,
    checkUpdates: async () => assert.fail('must not look up versions')
  });
  await afterCommand('list', {}, { ...deps, tty: { ...ALL_TTY, stdout: false } });
  await afterCommand('daemon', {}, deps);
  await afterCommand('history', { json: true }, deps);
  await afterCommand('list', {}, { ...deps, env: { UPDEPS_NO_NOTICES: '1' } });
  assert.deepEqual(log.printed, []);
});

test('afterCommand: the desktop app tip shows while the app is missing, except for `updeps gui`', async () => {
  const tip = /^Tip: updeps has a desktop app .* Install it with: updeps gui install$/;
  let { deps, log } = fakeDeps({ findApp: () => null, checkUpdates: async () => ({ cli: { update: false }, app: { latest: null } }) });
  await afterCommand('list', {}, deps);
  await afterCommand('list', {}, deps);
  assert.equal(log.printed.length, 2, 'on every command');
  assert.match(log.printed[0], tip);

  ({ deps, log } = fakeDeps({ findApp: () => null, checkUpdates: async () => ({ cli: { update: false }, app: { latest: null } }) }));
  await afterCommand('gui', {}, deps);
  assert.deepEqual(log.printed, []);

  ({ deps, log } = fakeDeps({ checkUpdates: async () => ({ cli: { update: false }, app: { latest: null } }) }));
  await afterCommand('list', {}, deps);
  assert.deepEqual(log.printed, [], 'no tip once the app is installed');
});

test('afterCommand: no prompt when there is no CLI update or it is snoozed', async () => {
  let { deps, log, cli } = fakeDeps({ checkUpdates: async () => ({ cli: { update: false, latest: '0.3.0' }, app: { latest: null } }) });
  await afterCommand('list', {}, deps);
  assert.deepEqual(log.asked, []);

  ({ deps, log, cli } = fakeDeps({ isSnoozed: (version, now) => version === '0.3.0' && now === 1_000 }));
  await afterCommand('list', {}, deps);
  assert.deepEqual(log.asked, []);
  assert.deepEqual(log.printed, []);
});

test('afterCommand: declining snoozes the version and says how to update later', async () => {
  const { deps, log } = fakeDeps({ ask: async (q) => (log.asked.push(q), false) });
  await afterCommand('list', {}, deps);
  assert.deepEqual(log.asked, ['Update now? [Y/n] ']);
  assert.deepEqual(log.printed, [
    'updeps 0.3.0 is available (installed: 0.2.0).',
    'Update later with: npm install -g @sqaft/updeps-cli'
  ]);
  assert.deepEqual(log.snoozed, [['0.3.0', 1_000]]);
  assert.equal(log.installs, 0);
});

test('afterCommand: accepting installs the update and restarts an idle daemon', async () => {
  const { deps, log } = fakeDeps({ daemonPid: () => 4242 });
  await afterCommand('list', {}, deps);
  assert.equal(log.installs, 1);
  assert.equal(log.restarts, 1);
  assert.deepEqual(log.snoozed, []);
  assert.deepEqual(log.printed, ['updeps 0.3.0 is available (installed: 0.2.0).', 'updeps 0.3.0 installed.']);
});

test('afterCommand: a busy daemon is not interrupted', async () => {
  const { deps, log } = fakeDeps({ daemonPid: () => 4242, daemonBusy: () => true });
  await afterCommand('list', {}, deps);
  assert.equal(log.restarts, 0);
  assert.equal(log.printed.at(-1), 'Run "updeps restart" when the current update finishes.');
});

test('afterCommand: no daemon, nothing to restart', async () => {
  const { deps, log } = fakeDeps();
  await afterCommand('list', {}, deps);
  assert.equal(log.restarts, 0);
  assert.equal(log.printed.at(-1), 'updeps 0.3.0 installed.');
});

test('afterCommand: a failed restart is reported, not thrown', async () => {
  const { deps, log } = fakeDeps({ daemonPid: () => 4242, restartDaemon: () => ({ status: 1 }) });
  await afterCommand('list', {}, deps);
  assert.equal(log.printed.at(-1), 'The daemon did not restart. Run "updeps restart".');
});

test('afterCommand: a failing npm is reported with the manual command, without throwing', async () => {
  for (const failure of [{ status: 243 }, { error: new Error('spawn npm ENOENT'), status: null }]) {
    const { deps, log } = fakeDeps({ installCli: () => failure, daemonPid: () => 4242 });
    await afterCommand('list', {}, deps);
    assert.match(log.printed.at(-1), /^Could not update updeps \(.+\)\. Update manually with: npm install -g @sqaft\/updeps-cli$/);
    assert.equal(log.restarts, 0);
  }
});

test('afterCommand: when the installed version did not change, npm installed elsewhere', async () => {
  for (const installed of ['0.2.0', null]) {
    const { deps, log } = fakeDeps({ readInstalledVersion: () => installed, daemonPid: () => 4242 });
    await afterCommand('list', {}, deps);
    assert.match(log.printed.at(-1), /npm installed it somewhere else\. Update manually with: npm install -g @sqaft\/updeps-cli$/);
    assert.ok(!log.printed.some((line) => line.includes('installed.')));
    assert.equal(log.restarts, 0);
  }
});

/** Runs the real CLI with no terminal attached against a registry that counts requests. */
async function runCli(args, env) {
  const child = spawn(process.execPath, [BIN_PATH, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const status = await new Promise((resolve) => child.on('close', resolve));
  return { status, stdout, stderr };
}

test('a run without a terminal prints nothing extra and contacts no registry', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.end(JSON.stringify({ latest: '99.0.0' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const noticeEnv = { UPDEPS_REGISTRY: `http://127.0.0.1:${server.address().port}` };
    const quiet = { ...noticeEnv, UPDEPS_NO_NOTICES: '1' };

    const init = await runCli(['init', '--example'], quiet);
    assert.equal(init.status, 0, init.stderr);

    // Same command with the notices explicitly on and off: identical output, no request.
    const env = { ...noticeEnv, UPDEPS_NO_NOTICES: '' };
    for (const args of [['list'], ['history', '--json', '-n', '1'], ['graph']]) {
      const on = await runCli(args, env);
      const off = await runCli(args, quiet);
      assert.equal(on.status, off.status, args.join(' '));
      assert.equal(on.stdout, off.stdout, args.join(' '));
      assert.equal(on.stderr, off.stderr, args.join(' '));
      assert.equal(on.stderr, '', args.join(' '));
    }
    assert.deepEqual(requests, []);
    assert.deepEqual(JSON.parse((await runCli(['history', '--json', '-n', '1'], env)).stdout), []);
    assert.equal(fs.existsSync(path.join(dir, 'state', 'sqaft-updeps', 'updates.json')), false);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
