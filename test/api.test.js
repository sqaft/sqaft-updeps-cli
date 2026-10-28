import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmpDir, initGitRepo } from './helpers.js';

const { dir, cleanup } = tmpDir('updeps-api-');
process.env.XDG_STATE_HOME = path.join(dir, 'state');
process.env.XDG_CONFIG_HOME = path.join(dir, 'config');

const api = await import('@sqaft/updeps-cli/api');
const { appendEvent } = await import('../src/journal.js');
const { saveState, loadState } = await import('../src/state.js');

test.after(cleanup);

test('the package exports the API at @sqaft/updeps-cli/api', () => {
  assert.equal(api.API_VERSION, 1);
  assert.match(api.VERSION, /^\d+\.\d+\.\d+/);
  assert.equal(api.paths.configFile, path.join(dir, 'config', 'sqaft-updeps', 'config.json'));
  assert.ok(fs.existsSync(api.BIN_PATH));
  assert.ok(api.VALID_TRIGGERS.includes('push'));
});

test('resolvePath and displayPath: `~` paths as the config writes them', () => {
  const home = os.homedir();
  assert.equal(api.resolvePath('~/w/lib'), path.join(home, 'w', 'lib'));
  assert.equal(api.displayPath(path.join(home, 'w', 'lib')), `~${path.sep}w${path.sep}lib`);
  assert.equal(api.displayPath(path.resolve('/elsewhere')), path.resolve('/elsewhere'));
});

test('readConfigFile: missing, invalid JSON, and a config as written', () => {
  assert.deepEqual(api.readConfigFile(), { exists: false, raw: null, error: null });

  fs.mkdirSync(api.paths.configDir, { recursive: true });
  fs.writeFileSync(api.paths.configFile, '{ nope');
  const broken = api.readConfigFile();
  assert.equal(broken.exists, true);
  assert.match(broken.error, /not valid JSON/);

  fs.writeFileSync(api.paths.configFile, JSON.stringify({ repos: [{ path: '~/a' }] }));
  assert.deepEqual(api.readConfigFile().raw, { repos: [{ path: '~/a' }] });
});

test('checkConfig: resolved targets, derived {pkgs}, cycles and unknown-field warnings', () => {
  const raw = {
    _comment: 'kept',
    repos: [
      { path: '/r/a', name: '@x/a', packages: [{ path: '/r/b' }, { path: '/r/c', comands: ['typo'] }] },
      { path: '/r/b', name: '@x/b', packages: [{ path: '/r/c' }, { path: '/r/a' }] }
    ]
  };
  const res = api.checkConfig(raw);
  assert.equal(res.ok, true);
  assert.equal(res.error, null);
  assert.deepEqual(res.warnings, ['unknown field: repos[0].packages[1].comands']);
  assert.deepEqual(res.pkgs[path.resolve('/r/c')], ['@x/a', '@x/b']);
  assert.equal(res.config.repos[0].packages[0].commitMessage, api.DEFAULT_VALUES.commitMessage);
  assert.equal(res.cycles.length, 1);

  const bad = api.checkConfig({ repos: [{ packages: [] }] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /repos\[0\]\.path/);
  assert.equal(bad.config, null);
});

test('writeConfigFile: validates first, then writes unknown and comment fields back as they are', () => {
  fs.writeFileSync(api.paths.configFile, '{"repos": []}');
  assert.throws(() => api.writeConfigFile({ repos: 'no' }), api.ConfigError);
  assert.equal(fs.readFileSync(api.paths.configFile, 'utf8'), '{"repos": []}');

  const raw = { _comment: 'mine', repos: [{ path: '~/a', packages: [{ path: '~/b', extra: 1 }] }] };
  api.writeConfigFile(raw);
  assert.deepEqual(JSON.parse(fs.readFileSync(api.paths.configFile, 'utf8')), raw);
});

test('inspectRepo: git details and the package name from the manifest', () => {
  const missing = api.inspectRepo(path.join(dir, 'nope'));
  assert.equal(missing.exists, false);

  const { dir: repo, git } = initGitRepo(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(repo, 'composer.json'), JSON.stringify({ name: 'acme/lib' }));
  const remote = path.join(dir, 'lib-remote.git');
  git(['init', '-q', '--bare', '-b', 'main', remote]);
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-q', '-u', 'origin', 'main']);

  const info = api.inspectRepo(repo);
  assert.equal(info.exists, true);
  assert.equal(info.isGit, true);
  assert.equal(info.origin, remote);
  assert.deepEqual(info.branches, ['main']);
  assert.equal(info.packageName, 'acme/lib');
  assert.equal(info.manifest, 'composer.json');

  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: '@acme/lib' }));
  assert.equal(api.inspectRepo(repo).packageName, '@acme/lib');

  const plain = path.join(dir, 'go-mod');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'go.mod'), 'module example.com/acme/lib\n\ngo 1.22\n');
  const goInfo = api.inspectRepo(plain);
  assert.equal(goInfo.isGit, false);
  assert.equal(goInfo.packageName, 'example.com/acme/lib');
});

test('readStatus: no daemon means no running job or queue, failures and runs are kept', () => {
  saveState({
    ...loadState(),
    daemon: { pid: 999999, startedAt: 1, watchedRepos: 2 },
    activeRun: { source: 'a', target: 'b' },
    queue: { pending: 1, jobs: [{ target: 'c' }] },
    openFailures: [{ source: 'a', target: 'b', message: 'boom' }],
    lastRuns: [{ sourceRepo: 'a', committed: 1 }]
  });
  const status = api.readStatus();
  assert.equal(status.daemon.running, false);
  assert.equal(status.activeRun, null);
  assert.deepEqual(status.queue, { pending: 0, jobs: [] });
  assert.equal(status.openFailures.length, 1);
  assert.equal(status.lastRuns.length, 1);
});

test('readHistory and readRun: journal target runs, newest first, and a run by name', () => {
  appendEvent({ kind: 'group_start', group: 'g1', source: 'lib', trigger: 'push', sha: 'a'.repeat(40) });
  appendEvent({ kind: 'target', group: 'g1', source: 'lib', target: 'app', status: 'failed', message: 'boom' });
  appendEvent({ kind: 'target', group: 'g1', source: 'lib', target: 'web', status: 'committed', message: 'ok' });
  appendEvent({ kind: 'group_done', group: 'g1', committed: 1, failed: 1, unchanged: 0, skipped: 0 });

  assert.deepEqual(api.readHistory().map((r) => r.target), ['web', 'app']);
  assert.deepEqual(api.readHistory({ failed: true }).map((r) => r.target), ['app']);
  assert.deepEqual(api.readHistory({ repo: 'web' }).map((r) => r.target), ['web']);

  const run = api.readRun('app');
  assert.equal(run.group, 'g1');
  assert.equal(run.start.source, 'lib');
  assert.equal(run.done.committed, 1);
  assert.deepEqual(run.targets.map((t) => t.target), ['app', 'web']);
  assert.equal(api.readRun('nothing'), null);
});

test('inspectService: the platform backend and whether it is installed', () => {
  const service = api.inspectService();
  assert.ok(['launchd', 'systemd', 'startup', 'background'].includes(service.id));
  assert.equal(typeof service.installed, 'boolean');
});
