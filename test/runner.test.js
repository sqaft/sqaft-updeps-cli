import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers.js';

const { dir, cleanup } = tmpDir('updeps-runner-');
process.env.XDG_STATE_HOME = dir;
process.env.XDG_CONFIG_HOME = dir;

const { rejectReason, targetAccepts, runTarget } = await import('../src/runner.js');
const { resolveConfig } = await import('../src/config.js');
const { readEvents } = await import('../src/journal.js');
const { shellQuote } = await import('../src/exec.js');

test.after(cleanup);

function g(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

test('rejectReason: the manual trigger is always accepted', () => {
  const target = { triggers: ['push'], branches: ['main'] };
  assert.equal(rejectReason(target, { trigger: 'manual' }), null);
  assert.equal(targetAccepts(target, { trigger: 'manual' }), true);
});

test('rejectReason: rejects a trigger type that is disabled', () => {
  const target = { triggers: ['push'], branches: [] };
  assert.match(rejectReason(target, { trigger: 'fetch' }), /trigger 'fetch'/);
  assert.equal(targetAccepts(target, { trigger: 'fetch' }), false);
});

test('rejectReason: rejects a branch that is not listed, an empty list accepts every branch', () => {
  const target = { triggers: ['push'], branches: ['main'] };
  assert.match(rejectReason(target, { trigger: 'push', branch: 'develop' }), /branch 'develop'/);
  assert.equal(rejectReason(target, { trigger: 'push', branch: 'main' }), null);

  const noBranchFilter = { triggers: ['push'], branches: [] };
  assert.equal(rejectReason(noBranchFilter, { trigger: 'push', branch: 'anything' }), null);
});

test('runTarget: a command cancelled via AbortSignal ends as "failed" and the lock is released', async () => {
  const target = path.join(dir, 'abort-target');
  fs.mkdirSync(target);
  g(['init', '-q', '-b', 'main'], target);
  g(['config', 'user.email', 't@t.t'], target);
  g(['config', 'user.name', 't'], target);
  fs.writeFileSync(path.join(target, 'f.txt'), 'v1\n');
  g(['add', '-A'], target);
  g(['commit', '-qm', 'init'], target);

  const config = resolveConfig({
    notifications: false,
    defaults: { commandTimeout: 30 },
    repos: [
      {
        path: target, // source == target, only so runTarget can be called directly
        name: 'src',
        packages: [{ path: target, name: 'tgt', commands: ['sleep 5'] }]
      }
    ]
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);

  const result = await runTarget({
    config,
    target: config.repos[0].packages[0],
    trigger: { trigger: 'manual', sourceName: 'src', sourcePath: target },
    signal: controller.signal
  });

  assert.equal(result.status, 'failed');
  assert.match(result.message, /daemon shut down/);

  // lock released, a new run can start on the same target right away
  const { acquireLock } = await import('../src/lock.js');
  const lock = await acquireLock(target, { waitTimeoutSec: 1 });
  lock.release();
});

let repoSeq = 0;

/**
 * Target repo: package.json, package-lock.json and src/a.js are committed, the
 * working tree is clean. `otherProcess` is a script (outside the repo) that
 * runs in the background while the command executes, as another process that
 * creates notes.md and edits src/a.js.
 */
function makeTargetRepo(packageOverrides = {}) {
  const base = path.join(dir, `cp${++repoSeq}`);
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  g(['init', '-q', '-b', 'main'], repo);
  g(['config', 'user.email', 't@t.t'], repo);
  g(['config', 'user.name', 't'], repo);
  fs.writeFileSync(path.join(repo, 'package.json'), 'manifest-v1\n');
  fs.writeFileSync(path.join(repo, 'package-lock.json'), 'lock-v1\n');
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'export const a = 1;\n');
  g(['add', '-A'], repo);
  g(['commit', '-qm', 'init'], repo);

  const otherProcess = path.join(base, 'other-process.sh');
  fs.writeFileSync(otherProcess, "echo 'not' > notes.md\necho '// other process' >> src/a.js\n");

  const build = (commands) => {
    const config = resolveConfig({
      notifications: false,
      defaults: { commandTimeout: 30 },
      repos: [{ path: repo, name: 'src', packages: [{ path: repo, name: 'tgt', commands, ...packageOverrides }] }]
    });
    return { config, target: config.repos[0].packages[0] };
  };
  return { repo, otherProcess: `bash ${shellQuote(otherProcess)}`, build };
}

function run({ config, target }, repo, extra = {}) {
  return runTarget({
    config,
    target,
    trigger: { trigger: 'manual', sourceName: 'src', sourcePath: repo, sha: 'a'.repeat(40) },
    ...extra
  });
}

const committedFiles = (repo) =>
  g(['show', '--name-only', '--format=', 'HEAD'], repo).split('\n').filter(Boolean).sort();
const porcelain = (repo) =>
  spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' })
    .stdout.split('\n')
    .filter(Boolean)
    .sort();

test('commitPaths: files created/edited by another process during the command are not committed and stay in place', async () => {
  const { repo, otherProcess, build } = makeTargetRepo();
  const t = build([`${otherProcess} & echo lock-v2 > package-lock.json; wait`]);

  const result = await run(t, repo);

  assert.equal(result.status, 'committed');
  assert.deepEqual(committedFiles(repo), ['package-lock.json']);
  assert.equal(g(['show', 'HEAD:package-lock.json'], repo), 'lock-v2');
  // the other process's work is still in the working tree
  assert.deepEqual(porcelain(repo), [' M src/a.js', '?? notes.md']);
  assert.match(fs.readFileSync(path.join(repo, 'src', 'a.js'), 'utf8'), /other process/);
  // the warning is in both the result and the journal
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /outside commitPaths.*(notes\.md.*src\/a\.js|src\/a\.js.*notes\.md)/);
  const evt = readEvents({ limit: 1, filter: (r) => r.kind === 'target' && r.targetPath === repo })[0];
  assert.deepEqual([...evt.otherFiles].sort(), ['notes.md', 'src/a.js']);
  assert.deepEqual(evt.files, ['package-lock.json']);
});

test('commitPaths: a new (untracked) lock file is committed at any depth, a non-matching untracked file stays', async () => {
  const { repo, build } = makeTargetRepo();
  const t = build(['mkdir -p packages/web && echo a > yarn.lock && echo b > packages/web/yarn.lock && echo log > install.log']);

  const result = await run(t, repo);

  assert.equal(result.status, 'committed');
  assert.deepEqual(committedFiles(repo), ['packages/web/yarn.lock', 'yarn.lock']);
  assert.deepEqual(porcelain(repo), ['?? install.log']);
});

test('commitPaths: a list given at the target level is applied (it replaces the default)', async () => {
  const { repo, build } = makeTargetRepo({ commitPaths: ['deps.lock', 'gen/**/*.json'] });
  const t = build(['mkdir -p gen/x && echo d > deps.lock && echo j > gen/x/y.json && echo lock-v2 > package-lock.json']);
  assert.deepEqual(t.target.commitPaths, ['deps.lock', 'gen/**/*.json']);

  const result = await run(t, repo);

  assert.equal(result.status, 'committed');
  assert.deepEqual(committedFiles(repo), ['deps.lock', 'gen/x/y.json']);
  // a file on the default list but not on the custom list was neither committed nor touched
  assert.deepEqual(porcelain(repo), [' M package-lock.json']);
  assert.match(result.warnings[0], /package-lock\.json/);
});

test('commitPaths: if only non-matching files change, the result is "unchanged" with a warning', async () => {
  const { repo, otherProcess, build } = makeTargetRepo();
  const t = build([`${otherProcess}`]);
  const head = g(['rev-parse', 'HEAD'], repo);

  const result = await run(t, repo);

  assert.equal(result.status, 'unchanged');
  assert.equal(g(['rev-parse', 'HEAD'], repo), head);
  assert.match(result.warnings[0], /src\/a\.js/);
  assert.deepEqual(porcelain(repo), [' M src/a.js', '?? notes.md']);
});

test('commitPaths: a failed command reverts only the lock file and leaves the other process\'s src/a.js edit alone', async () => {
  const { repo, otherProcess, build } = makeTargetRepo();
  const t = build([`${otherProcess} & echo lock-v2 > package-lock.json; wait; exit 3`]);
  const head = g(['rev-parse', 'HEAD'], repo);

  const result = await run(t, repo);

  assert.equal(result.status, 'failed');
  assert.match(result.message, /exit code 3/);
  assert.equal(g(['rev-parse', 'HEAD'], repo), head);
  assert.equal(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'), 'lock-v1\n'); // reverted
  assert.match(fs.readFileSync(path.join(repo, 'src', 'a.js'), 'utf8'), /other process/); // preserved
  assert.ok(fs.existsSync(path.join(repo, 'notes.md')));
  assert.match(result.warnings[0], /src\/a\.js/);
});

test('commitPaths: dry-run reverts only the lock file and leaves the other process\'s changes alone', async () => {
  const { repo, otherProcess, build } = makeTargetRepo();
  const t = build([`${otherProcess} & echo lock-v2 > package-lock.json; wait`]);
  const head = g(['rev-parse', 'HEAD'], repo);

  const result = await run(t, repo, { dryRun: true });

  assert.equal(result.status, 'committed');
  assert.match(result.message, /^\[dry-run\]/);
  assert.equal(g(['rev-parse', 'HEAD'], repo), head);
  assert.deepEqual(porcelain(repo), [' M src/a.js', '?? notes.md']);
});
