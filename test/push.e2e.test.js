import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir, TEST_SHELL } from './helpers.js';

const { dir: root, cleanup } = tmpDir('updeps-push-e2e-');
const dir = fs.realpathSync.native(root);
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
 * (appends to yarn.lock, so every run produces a commit) and one *unpushed*
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
  fs.writeFileSync(path.join(work, 'yarn.lock'), '');
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

const OK_BUMP = 'echo "$* $RANDOM$RANDOM" >> yarn.lock\n';
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

test('A→B→C: each repo is pushed in dependency order, C is updated only once', async () => {
  const a = makeRepo('chain', 'a', OK_BUMP);
  const b = makeRepo('chain', 'b', OK_BUMP);
  const c = makeRepo('chain', 'c', OK_BUMP);

  const config = resolveConfig({
    notifications: false,
    defaults: { debounceMs: 50, commands: ['bash bump.sh {pkgs}'], shell: TEST_SHELL },
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

    // B: a single update from A; C: a single update from B (it went out in one push together with B's own commit)
    assert.equal(depsCommits(b), 1);
    assert.equal(depsCommits(c), 1);
    assert.equal(depsCommits(a), 0);
    assert.match(fs.readFileSync(path.join(c, 'yarn.lock'), 'utf8'), /pkg-b/);
  } finally {
    await watcher.stop();
  }
});

test('stops and returns the failure when a target update fails', async () => {
  const a = makeRepo('fail', 'a', OK_BUMP);
  const b = makeRepo('fail', 'b', FAIL_BUMP);
  const c = makeRepo('fail', 'c', OK_BUMP);

  const config = resolveConfig({
    notifications: false,
    defaults: { debounceMs: 50, commands: ['bash bump.sh {pkgs}'], shell: TEST_SHELL },
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
    assert.equal(result.rounds.length, 1); // only A was pushed
    assert.equal(upstreamStatus(a).ahead, 0);
    assert.equal(upstreamStatus(b).ahead, 1); // B and C were left untouched
    assert.equal(upstreamStatus(c).ahead, 1);
  } finally {
    await watcher.stop();
  }
});

test('throws when the daemon is not running', async () => {
  const a = makeRepo('dead', 'a', OK_BUMP);
  const config = resolveConfig({
    notifications: false,
    defaults: { debounceMs: 50 },
    repos: [{ path: a, name: 'pkg-a', packages: [] }]
  });
  await assert.rejects(
    runCascade({ config, repos: [a], isDaemonAlive: () => false, pollMs: 10 }),
    /The daemon is not running/
  );
});

test('--commit: repos with changes are committed first, then pushed', async () => {
  const dirty = makeRepo('cm', 'dirty', OK_BUMP);
  const clean = makeRepo('cm', 'clean', OK_BUMP);
  const onlyDirty = makeRepo('cm', 'onlydirty', OK_BUMP);
  g(['push', '-q', 'origin', 'main'], onlyDirty); // only a dirty file, no unpushed commit

  fs.writeFileSync(path.join(dirty, 'own.txt'), 'changed\n'); // tracked change
  fs.writeFileSync(path.join(dirty, 'new.txt'), 'new\n'); // untracked file
  fs.rmSync(path.join(dirty, 'bump.sh')); // deleted file
  fs.writeFileSync(path.join(onlyDirty, 'own.txt'), 'wip\n');

  const config = resolveConfig({ notifications: false, defaults: { debounceMs: 50 }, repos: [] });
  const lines = [];
  const result = await runCascade({
    config,
    repos: [dirty, clean, onlyDirty],
    isDaemonAlive: () => true,
    pollMs: 50,
    commitMessage: 'wip: bulk commit',
    log: (l) => lines.push(l)
  });

  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.committed.map((c) => c.label).sort(), ['cm-dirty', 'cm-onlydirty']);
  for (const repo of [dirty, clean, onlyDirty]) {
    assert.equal(upstreamStatus(repo).ahead, 0);
    assert.equal(g(['status', '--porcelain'], repo), '');
  }
  assert.equal(g(['log', '-1', '--format=%s'], dirty), 'wip: bulk commit');
  assert.deepEqual(
    g(['show', '--name-status', '--format=', 'HEAD'], dirty).split('\n').sort(),
    ['A\tnew.txt', 'D\tbump.sh', 'M\town.txt']
  );
  assert.notEqual(g(['log', '-1', '--format=%s'], clean), 'wip: bulk commit'); // the clean repo was not committed
  assert.equal(g(['log', '-1', '--format=%s'], onlyDirty), 'wip: bulk commit');
  assert.ok(lines.some((l) => l.startsWith('Commit: cm-dirty')));
});

test('--commit: a committed source change flows to the rest of the chain with the push', async () => {
  const a = makeRepo('cc', 'a', OK_BUMP);
  const b = makeRepo('cc', 'b', OK_BUMP);
  fs.writeFileSync(path.join(a, 'own.txt'), 'edited\n');

  const config = resolveConfig({
    notifications: false,
    defaults: { debounceMs: 50, commands: ['bash bump.sh {pkgs}'], shell: TEST_SHELL },
    repos: [{ path: a, name: 'pkg-a', packages: [{ path: b, name: 'b' }] }]
  });
  const { watcher } = startDaemon(config);
  await new Promise((r) => setTimeout(r, 100));

  try {
    const result = await runCascade({
      config,
      repos: [a, b],
      isDaemonAlive: () => true,
      pollMs: 50,
      commitMessage: 'edit a'
    });
    assert.deepEqual(result.failed, []);
    assert.equal(result.committed.length, 1);
    assert.equal(g(['log', '-1', '--format=%s'], a), 'edit a');
    assert.equal(upstreamStatus(a).ahead, 0);
    assert.equal(upstreamStatus(b).ahead, 0);
    assert.equal(depsCommits(b), 1);
  } finally {
    await watcher.stop();
  }
});

test('--commit: no repo is pushed when a commit fails (hook)', async () => {
  const first = makeRepo('ch', 'a-first', OK_BUMP); // sorts first, has an unpushed commit
  const hooked = makeRepo('ch', 'b-hooked', OK_BUMP);
  fs.writeFileSync(path.join(hooked, 'own.txt'), 'dirty\n');
  fs.writeFileSync(path.join(hooked, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint failed" >&2\nexit 1\n', {
    mode: 0o755
  });

  const config = resolveConfig({ notifications: false, defaults: { debounceMs: 50 }, repos: [] });
  await assert.rejects(
    runCascade({
      config,
      repos: [first, hooked],
      isDaemonAlive: () => true,
      pollMs: 50,
      commitMessage: 'x'
    }),
    /\[ch-b-hooked\] commit failed, nothing was pushed/
  );
  assert.equal(upstreamStatus(first).ahead, 1);
  assert.equal(upstreamStatus(hooked).ahead, 1);
});

test('--commit: a repo with unresolved conflicts is not committed', async () => {
  const repo = makeRepo('cu', 'conflict', OK_BUMP);
  g(['checkout', '-q', '-b', 'other', 'HEAD~1'], repo);
  fs.writeFileSync(path.join(repo, 'own.txt'), 'other side\n');
  g(['commit', '-aqm', 'other'], repo);
  g(['checkout', '-q', 'main'], repo);
  spawnSync('git', ['merge', 'other'], { cwd: repo, encoding: 'utf8' }); // conflicts, MERGE_HEAD remains

  const config = resolveConfig({ notifications: false, defaults: { debounceMs: 50 }, repos: [] });
  const result = await runCascade({
    config,
    repos: [repo],
    isDaemonAlive: () => true,
    pollMs: 50,
    commitMessage: 'x'
  });
  // a repo in the middle of a merge is already out of scope; nothing is committed
  assert.deepEqual(result.committed, []);
  assert.equal(result.skipped.length, 1);
  assert.match(g(['status', '--porcelain'], repo), /UU own\.txt/);
});
