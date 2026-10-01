import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers.js';

const { dir: root, cleanup } = tmpDir('updeps-push-e2e-');
const dir = fs.realpathSync(root);
process.env.XDG_STATE_HOME = path.join(dir, 'state');
process.env.XDG_CONFIG_HOME = path.join(dir, 'config');

const { resolveConfig } = await import('../src/config.js');
const { UpdateQueue } = await import('../src/queue.js');
const { ReflogWatcher } = await import('../src/watcher.js');
const { runCascade } = await import('../src/cascade.js');
const { upstreamStatus } = await import('../src/gitops.js');

test.after(cleanup);

function g(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Creates `<name>` with a bare remote, one pushed commit, a bump script
 * (appends to deps.lock, so every run produces a commit) and one *unpushed*
 * local commit.
 */
function makeRepo(prefix, name, bump) {
  const remote = path.join(dir, `${prefix}-${name}.git`);
  const work = path.join(dir, `${prefix}-${name}`);
  fs.mkdirSync(remote);
  g(['init', '-q', '--bare', '-b', 'main'], remote);
  fs.mkdirSync(work);
  g(['init', '-q', '-b', 'main'], work);
  g(['config', 'user.email', 't@t.t'], work);
  g(['config', 'user.name', 't'], work);
  fs.writeFileSync(path.join(work, 'deps.lock'), '');
  fs.writeFileSync(path.join(work, 'bump.sh'), bump);
  fs.writeFileSync(path.join(work, 'own.txt'), '1\n');
  g(['add', '-A'], work);
  g(['commit', '-qm', 'init'], work);
  g(['remote', 'add', 'origin', remote], work);
  g(['push', '-q', '-u', 'origin', 'main'], work);

  fs.writeFileSync(path.join(work, 'own.txt'), '2\n');
  g(['commit', '-aqm', `own change ${name}`], work);
  return work;
}

const OK_BUMP = 'echo "$* $RANDOM$RANDOM" >> deps.lock\n';
const FAIL_BUMP = 'echo boom >&2\nexit 1\n';

function startDaemon(config) {
  const queue = new UpdateQueue(config, {});
  const watcher = new ReflogWatcher(config, queue);
  watcher.start();
  return { queue, watcher };
}

const depsCommits = (repo) =>
  g(['log', '--format=%s'], repo)
    .split('\n')
    .filter((s) => s.startsWith('chore(deps)')).length;

test('A→B→C: her repo bağımlılık sırasıyla push edilir, C yalnızca bir kez güncellenir', async () => {
  const a = makeRepo('chain', 'a', OK_BUMP);
  const b = makeRepo('chain', 'b', OK_BUMP);
  const c = makeRepo('chain', 'c', OK_BUMP);

  const config = resolveConfig({
    notifications: false,
    defaults: { debounceMs: 50, commands: ['bash bump.sh {pkgs}'] },
    repos: [
      { path: a, name: 'pkg-a', packages: [{ path: b, name: 'b' }] },
      { path: b, name: 'pkg-b', packages: [{ path: c, name: 'c' }] }
    ]
  });
  const { watcher } = startDaemon(config);
  await new Promise((r) => setTimeout(r, 100));

  try {
    const lines = [];
    const result = await runCascade({
      config,
      repos: [a, b, c],
      isDaemonAlive: () => true,
      pollMs: 50,
      log: (l) => lines.push(l)
    });

    assert.deepEqual(result.failed, []);
    assert.equal(result.rounds.length, 3);
    assert.deepEqual(
      result.rounds.map((r) => r.pushed.map((x) => x.label)),
      [['chain-a'], ['chain-b'], ['chain-c']]
    );

    for (const repo of [a, b, c]) assert.equal(upstreamStatus(repo).ahead, 0);

    // B: A'dan tek güncelleme; C: B'den tek güncelleme (B'nin kendi commit'iyle birlikte tek push'ta gitti)
    assert.equal(depsCommits(b), 1);
    assert.equal(depsCommits(c), 1);
    assert.equal(depsCommits(a), 0);
    assert.match(fs.readFileSync(path.join(c, 'deps.lock'), 'utf8'), /pkg-b/);
  } finally {
    await watcher.stop();
  }
});

test('hedef güncellemesi başarısız olursa döngü durur ve hatayı döndürür', async () => {
  const a = makeRepo('fail', 'a', OK_BUMP);
  const b = makeRepo('fail', 'b', FAIL_BUMP);
  const c = makeRepo('fail', 'c', OK_BUMP);

  const config = resolveConfig({
    notifications: false,
    defaults: { debounceMs: 50, commands: ['bash bump.sh {pkgs}'] },
    repos: [
      { path: a, name: 'pkg-a', packages: [{ path: b, name: 'b' }] },
      { path: b, name: 'pkg-b', packages: [{ path: c, name: 'c' }] }
    ]
  });
  const { watcher } = startDaemon(config);
  await new Promise((r) => setTimeout(r, 100));

  try {
    const result = await runCascade({
      config,
      repos: [a, b, c],
      isDaemonAlive: () => true,
      pollMs: 50
    });

    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].target, 'b');
    assert.equal(result.rounds.length, 1); // yalnızca A push edildi
    assert.equal(upstreamStatus(a).ahead, 0);
    assert.equal(upstreamStatus(b).ahead, 1); // B ve C dokunulmadı
    assert.equal(upstreamStatus(c).ahead, 1);
  } finally {
    await watcher.stop();
  }
});

test('daemon çalışmıyorsa hata verir', async () => {
  const a = makeRepo('dead', 'a', OK_BUMP);
  const config = resolveConfig({
    notifications: false,
    defaults: { debounceMs: 50 },
    repos: [{ path: a, name: 'pkg-a', packages: [] }]
  });
  await assert.rejects(
    runCascade({ config, repos: [a], isDaemonAlive: () => false, pollMs: 10 }),
    /Daemon çalışmıyor/
  );
});
