import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, initGitRepo } from './helpers.js';
import { resolveConfig } from '../src/config.js';
import { buildGraph, pickPushable, planRounds, discoverRepos } from '../src/cascade.js';

/** Path of a repo under /work, absolute on this platform (`D:\\work\\a` on Windows). */
const p = (name) => path.resolve('/work', name);

/** edges: [['a','b']] = a is a source, b a target. Repos live under /work. */
function graphOf(edges) {
  const bySource = new Map();
  for (const [s, t] of edges) {
    if (!bySource.has(s)) bySource.set(s, []);
    bySource.get(s).push(t);
  }
  const repos = [...bySource].map(([s, targets]) => ({
    path: p(s),
    name: s,
    packages: targets.map((t) => ({ path: p(t), name: t }))
  }));
  return buildGraph(resolveConfig({ repos }));
}

const names = (paths) => paths.map((x) => path.basename(x)).sort();

test('pickPushable: only the topmost repo of a chain is pushed', () => {
  const g = graphOf([['a', 'b'], ['b', 'c']]);
  assert.deepEqual(names(pickPushable([p('a'), p('b'), p('c')], g)), ['a']);
  assert.deepEqual(names(pickPushable([p('b'), p('c')], g)), ['b']);
  assert.deepEqual(names(pickPushable([p('c')], g)), ['c']);
});

test('pickPushable: a transitive ancestor blocks even when the middle node is not ahead', () => {
  const g = graphOf([['a', 'b'], ['b', 'c']]);
  assert.deepEqual(names(pickPushable([p('a'), p('c')], g)), ['a']);
});

test('pickPushable: the shared target of a diamond goes last', () => {
  const g = graphOf([['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]);
  assert.deepEqual(names(pickPushable([p('a'), p('b'), p('c'), p('d')], g)), ['a']);
  assert.deepEqual(names(pickPushable([p('b'), p('c'), p('d')], g)), ['b', 'c']);
});

test('pickPushable: an unrelated repo is pushed right away', () => {
  const g = graphOf([['a', 'b']]);
  assert.deepEqual(names(pickPushable([p('a'), p('b'), p('z')], g)), ['a', 'z']);
});

test('pickPushable: only blocking (daemon-watched) ancestors hold a repo back', () => {
  const g = graphOf([['a', 'b']]);
  const ahead = [p('a'), p('b')];
  assert.deepEqual(names(pickPushable(ahead, g, new Set())), ['a', 'b']);
  assert.deepEqual(names(pickPushable(ahead, g, new Set([p('a')]))), ['a']);
});

test('pickPushable: repos in a cycle wait for each other (empty set)', () => {
  const g = graphOf([['a', 'b'], ['b', 'a']]);
  assert.deepEqual(pickPushable([p('a'), p('b')], g), []);
});

function info(name, ahead, watched = true) {
  return { path: p(name), label: name, ahead, watched };
}

test('planRounds: A→B→C rounds and possible commits', () => {
  const g = graphOf([['a', 'b'], ['b', 'c']]);
  const rounds = planRounds([info('a', 2), info('b', 0), info('c', 0)], g);
  assert.deepEqual(
    rounds.map((r) => r.repos.map((x) => [path.basename(x.path), x.certain])),
    [[['a', true]], [['b', false]], [['c', false]]]
  );
});

test('planRounds: a target that is already ahead is pushed once, as certain', () => {
  const g = graphOf([['a', 'b'], ['b', 'c']]);
  const rounds = planRounds([info('a', 1), info('b', 1), info('c', 1)], g);
  assert.deepEqual(
    rounds.map((r) => r.repos.map((x) => [path.basename(x.path), x.certain])),
    [[['a', true]], [['b', true]], [['c', true]]]
  );
});

test('planRounds: no rounds when there is nothing to push; stuck on a cycle', () => {
  const g = graphOf([['a', 'b']]);
  assert.deepEqual(planRounds([info('a', 0), info('b', 0)], g), []);
  const cyc = graphOf([['a', 'b'], ['b', 'a']]);
  const rounds = planRounds([info('a', 1), info('b', 1)], cyc);
  assert.deepEqual(names(rounds[0].stuck), ['a', 'b']);
});

test('discoverRepos: outside a repo, finds only repos one level down and skips node_modules/vendor/dot directories', () => {
  const { dir, cleanup } = tmpDir('updeps-discover-');
  try {
    const root = fs.realpathSync.native(dir);
    for (const rel of ['a', 'b', 'group/deep', 'node_modules', 'vendor', '.hidden', 'a/nested']) {
      initGitRepo(path.join(root, rel));
    }
    fs.mkdirSync(path.join(root, 'empty'));

    assert.deepEqual(discoverRepos(root), [path.join(root, 'a'), path.join(root, 'b')]);
    assert.deepEqual(discoverRepos(path.join(root, 'empty')), []);
  } finally {
    cleanup();
  }
});

test('discoverRepos: inside a repo, returns that repo plus the repos one level below the current directory', () => {
  const { dir, cleanup } = tmpDir('updeps-discover-');
  try {
    // the native call expands Windows 8.3 short names the way git does
    const ws = path.join(fs.realpathSync.native(dir), 'ws');
    for (const rel of ['', 'a', 'b', 'group/deep', 'a/nested']) initGitRepo(path.join(ws, rel));
    fs.mkdirSync(path.join(ws, 'src'));

    // workspace repo + the project repos inside it
    assert.deepEqual(discoverRepos(ws), [ws, path.join(ws, 'a'), path.join(ws, 'b')]);
    // repo subdirectory: the enclosing repo (+ repos directly below that directory; none here)
    assert.deepEqual(discoverRepos(path.join(ws, 'src')), [ws]);
    // nested repo: the workspace above it is not in scope
    assert.deepEqual(discoverRepos(path.join(ws, 'a')), [path.join(ws, 'a'), path.join(ws, 'a', 'nested')]);
  } finally {
    cleanup();
  }
});
