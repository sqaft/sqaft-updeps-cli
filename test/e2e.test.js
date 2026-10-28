import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpDir } from './helpers.js';

const { dir, cleanup } = tmpDir('updeps-e2e-');
process.env.XDG_STATE_HOME = path.join(dir, 'state');
process.env.XDG_CONFIG_HOME = path.join(dir, 'config');

const { resolveConfig } = await import('../src/config.js');
const { UpdateQueue } = await import('../src/queue.js');
const { ReflogWatcher } = await import('../src/watcher.js');
const { runTarget } = await import('../src/runner.js');

test.after(cleanup);

function g(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

test('push → only the lock file is committed in the dependent target', async () => {
  const remote = path.join(dir, 'remote.git');
  const source = path.join(dir, 'source');
  const target = path.join(dir, 'target');

  fs.mkdirSync(remote);
  g(['init', '-q', '--bare', '-b', 'main'], remote);

  // source repo
  fs.mkdirSync(source);
  g(['init', '-q', '-b', 'main'], source);
  g(['config', 'user.email', 't@t.t'], source);
  g(['config', 'user.name', 't'], source);
  fs.writeFileSync(path.join(source, 'index.js'), 'v1\n');
  g(['add', '-A'], source);
  g(['commit', '-qm', 'init'], source);
  g(['remote', 'add', 'origin', remote], source);
  g(['push', '-q', '-u', 'origin', 'main'], source);

  // target repo with a "lock" file and an update script
  fs.mkdirSync(target);
  g(['init', '-q', '-b', 'main'], target);
  g(['config', 'user.email', 't@t.t'], target);
  g(['config', 'user.name', 't'], target);
  fs.writeFileSync(path.join(target, 'yarn.lock'), 'source=old\n');
  fs.writeFileSync(
    path.join(target, 'bump.sh'),
    '#!/usr/bin/env bash\necho "source=new $*" > yarn.lock\n',
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(target, 'src.js'), 'export const x = 1;\n');
  g(['add', '-A'], target);
  g(['commit', '-qm', 'init'], target);

  // developer has uncommitted work in the target
  fs.writeFileSync(path.join(target, 'src.js'), 'export const x = 2; // WIP\n');

  const config = resolveConfig({
    notifications: false,
    defaults: { debounceMs: 50, commitMessage: 'deps: {pkg}@{sha}' },
    repos: [
      {
        path: source,
        name: 'my-source',
        packages: [{ path: target, name: 'my-target', commands: ['bash bump.sh {pkgs}'] }]
      }
    ]
  });

  const done = [];
  const queue = new UpdateQueue(config, { onGroupDone: (grp) => done.push(grp) });
  const watcher = new ReflogWatcher(config, queue);
  watcher.start();
  await sleep(100);

  // trigger: new commit + push on source
  fs.writeFileSync(path.join(source, 'index.js'), 'v2\n');
  g(['commit', '-aqm', 'v2'], source);
  const sha = g(['rev-parse', 'HEAD'], source);
  g(['push', '-q', 'origin', 'main'], source);

  for (let i = 0; i < 100 && done.length === 0; i++) await sleep(50);
  await watcher.stop();

  assert.equal(done.length, 1);
  assert.equal(done[0].tally.committed, 1);

  // only yarn.lock was committed
  const files = g(['show', '--name-only', '--format=', 'HEAD'], target).split('\n').filter(Boolean);
  assert.deepEqual(files, ['yarn.lock']);

  // commit message templated
  const msg = g(['show', '-s', '--format=%s', 'HEAD'], target);
  assert.equal(msg, `deps: my-source@${sha.slice(0, 7)}`);

  // developer's WIP untouched
  assert.match(fs.readFileSync(path.join(target, 'src.js'), 'utf8'), /WIP/);

  // lock file content reflects the update command ({pkgs} = source name)
  assert.match(fs.readFileSync(path.join(target, 'yarn.lock'), 'utf8'), /source=new my-source/);
});

test('an update to an already-dirty target file is not silently lost', async () => {
  const source = path.join(dir, 'dirty-source');
  const target = path.join(dir, 'dirty-target');

  fs.mkdirSync(source);
  g(['init', '-q', '-b', 'main'], source);
  g(['config', 'user.email', 't@t.t'], source);
  g(['config', 'user.name', 't'], source);
  fs.writeFileSync(path.join(source, 'f.js'), 'v1\n');
  g(['add', '-A'], source);
  g(['commit', '-qm', 'init'], source);

  fs.mkdirSync(target);
  g(['init', '-q', '-b', 'main'], target);
  g(['config', 'user.email', 't@t.t'], target);
  g(['config', 'user.name', 't'], target);
  fs.writeFileSync(path.join(target, 'yarn.lock'), 'v1\n');
  fs.writeFileSync(
    path.join(target, 'bump.sh'),
    '#!/usr/bin/env bash\necho "v3" > yarn.lock\n',
    { mode: 0o755 }
  );
  g(['add', '-A'], target);
  g(['commit', '-qm', 'init'], target);

  // the user is already working on yarn.lock (dirty) — the command will modify it too
  fs.writeFileSync(path.join(target, 'yarn.lock'), 'v2-WIP\n');

  const config = resolveConfig({
    notifications: false,
    defaults: { commandTimeout: 30 },
    repos: [
      {
        path: source,
        name: 'src',
        packages: [{ path: target, name: 'tgt', commands: ['bash bump.sh'] }]
      }
    ]
  });

  const result = await runTarget({
    config,
    target: config.repos[0].packages[0],
    trigger: { trigger: 'manual', sourceName: 'src', sourcePath: source }
  });

  // neither "unchanged" (the update must not look silently lost) nor "failed"
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /already-dirty/);
  // the combined user + command state is kept: neither reverted nor committed
  assert.equal(fs.readFileSync(path.join(target, 'yarn.lock'), 'utf8'), 'v3\n');
  assert.equal(g(['status', '--porcelain'], target).trim() !== '', true); // still dirty, nothing committed
});
