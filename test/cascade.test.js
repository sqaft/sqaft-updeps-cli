import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, initGitRepo } from './helpers.js';
import { resolveConfig } from '../src/config.js';
import { buildGraph, pickPushable, planRounds, discoverRepos } from '../src/cascade.js';

/** edges: [['a','b']] = a is a source, b a target. Repos live under /work. */
function graphOf(edges) {
  const bySource = new Map();
  for (const [s, t] of edges) {
    if (!bySource.has(s)) bySource.set(s, []);
    bySource.get(s).push(t);
  }
  const repos = [...bySource].map(([s, targets]) => ({
    path: `/work/${s}`,
    name: s,
    packages: targets.map((t) => ({ path: `/work/${t}`, name: t }))
  }));
  return buildGraph(resolveConfig({ repos }));
}

const p = (name) => `/work/${name}`;
const names = (paths) => paths.map((x) => path.basename(x)).sort();

test('pickPushable: zincirde yalnızca en üstteki repo push edilir', () => {
  const g = graphOf([['a', 'b'], ['b', 'c']]);
  assert.deepEqual(names(pickPushable([p('a'), p('b'), p('c')], g)), ['a']);
  assert.deepEqual(names(pickPushable([p('b'), p('c')], g)), ['b']);
  assert.deepEqual(names(pickPushable([p('c')], g)), ['c']);
});

test('pickPushable: ara düğüm ahead değilse de transitif ata engeller', () => {
  const g = graphOf([['a', 'b'], ['b', 'c']]);
  assert.deepEqual(names(pickPushable([p('a'), p('c')], g)), ['a']);
});

test('pickPushable: elmasta ortak hedef en sona kalır', () => {
  const g = graphOf([['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]);
  assert.deepEqual(names(pickPushable([p('a'), p('b'), p('c'), p('d')], g)), ['a']);
  assert.deepEqual(names(pickPushable([p('b'), p('c'), p('d')], g)), ['b', 'c']);
});

test('pickPushable: ilişkisiz repo hemen push edilir', () => {
  const g = graphOf([['a', 'b']]);
  assert.deepEqual(names(pickPushable([p('a'), p('b'), p('z')], g)), ['a', 'z']);
});

test('pickPushable: yalnızca engelleyen (daemon izleyen) atalar bekletir', () => {
  const g = graphOf([['a', 'b']]);
  const ahead = [p('a'), p('b')];
  assert.deepEqual(names(pickPushable(ahead, g, new Set())), ['a', 'b']);
  assert.deepEqual(names(pickPushable(ahead, g, new Set([p('a')]))), ['a']);
});

test('pickPushable: döngüdeki repolar birbirini bekler (boş küme)', () => {
  const g = graphOf([['a', 'b'], ['b', 'a']]);
  assert.deepEqual(pickPushable([p('a'), p('b')], g), []);
});

function info(name, ahead, watched = true) {
  return { path: p(name), label: name, ahead, watched };
}

test('planRounds: A→B→C turları ve olası commit\'ler', () => {
  const g = graphOf([['a', 'b'], ['b', 'c']]);
  const rounds = planRounds([info('a', 2), info('b', 0), info('c', 0)], g);
  assert.deepEqual(
    rounds.map((r) => r.repos.map((x) => [path.basename(x.path), x.certain])),
    [[['a', true]], [['b', false]], [['c', false]]]
  );
});

test('planRounds: zaten ahead olan hedef bir kez, kesin olarak push edilir', () => {
  const g = graphOf([['a', 'b'], ['b', 'c']]);
  const rounds = planRounds([info('a', 1), info('b', 1), info('c', 1)], g);
  assert.deepEqual(
    rounds.map((r) => r.repos.map((x) => [path.basename(x.path), x.certain])),
    [[['a', true]], [['b', true]], [['c', true]]]
  );
});

test('planRounds: push edilecek şey yoksa tur yok; döngüde stuck', () => {
  const g = graphOf([['a', 'b']]);
  assert.deepEqual(planRounds([info('a', 0), info('b', 0)], g), []);
  const cyc = graphOf([['a', 'b'], ['b', 'a']]);
  const rounds = planRounds([info('a', 1), info('b', 1)], cyc);
  assert.deepEqual(names(rounds[0].stuck), ['a', 'b']);
});

test('discoverRepos: repo olmayan dizinde yalnızca bir alt seviyedeki repoları bulur, node_modules/vendor/dot dizinlerini atlar', () => {
  const { dir, cleanup } = tmpDir('updeps-discover-');
  try {
    const root = fs.realpathSync(dir);
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

test('discoverRepos: repo içinde o repo ve bulunulan dizinin bir alt seviyesindeki repolar döner', () => {
  const { dir, cleanup } = tmpDir('updeps-discover-');
  try {
    const ws = path.join(fs.realpathSync(dir), 'ws');
    for (const rel of ['', 'a', 'b', 'group/deep', 'a/nested']) initGitRepo(path.join(ws, rel));
    fs.mkdirSync(path.join(ws, 'src'));

    // workspace reposu + içindeki proje repoları
    assert.deepEqual(discoverRepos(ws), [ws, path.join(ws, 'a'), path.join(ws, 'b')]);
    // repo alt dizini: kapsayan repo (+ o dizinin hemen altındaki repolar; burada yok)
    assert.deepEqual(discoverRepos(path.join(ws, 'src')), [ws]);
    // iç içe repo: üstteki workspace kapsama girmez
    assert.deepEqual(discoverRepos(path.join(ws, 'a')), [path.join(ws, 'a'), path.join(ws, 'a', 'nested')]);
  } finally {
    cleanup();
  }
});
