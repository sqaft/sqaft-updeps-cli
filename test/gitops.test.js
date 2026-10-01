import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, initGitRepo } from './helpers.js';
import {
  statusSnapshot,
  diffSnapshots,
  selectiveCommit,
  safeRollback,
  checkPreconditions,
  hashPaths,
  upstreamStatus,
  remoteTip
} from '../src/gitops.js';
import { git } from '../src/exec.js';

test('yalnızca komutun değiştirdiği dosya commit\'lenir, kirli dosya korunur', () => {
  const { dir, cleanup } = tmpDir('updeps-git-');
  try {
    const { git: g } = initGitRepo(dir);
    fs.writeFileSync(path.join(dir, 'lock.json'), '{"v":1}\n');
    fs.writeFileSync(path.join(dir, 'src.js'), 'export const x = 1;\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'add files']);

    // kullanıcı src.js üzerinde çalışıyor (kirli)
    fs.writeFileSync(path.join(dir, 'src.js'), 'export const x = 2; // WIP\n');

    const before = statusSnapshot(dir);
    assert.ok(before.has('src.js'));

    // "komut" lock.json'u değiştirir
    fs.writeFileSync(path.join(dir, 'lock.json'), '{"v":2}\n');

    const after = statusSnapshot(dir);
    const { tracked, untracked } = diffSnapshots(before, after);
    const changed = [...tracked, ...untracked];
    assert.deepEqual(changed, ['lock.json']);

    selectiveCommit(dir, changed, 'bump lock');

    // lock.json commit'lendi
    assert.equal(git(['show', '--stat', '--format=%s', 'HEAD'], dir).split('\n')[0], 'bump lock');
    // src.js hâlâ kirli ve WIP içeriğiyle duruyor
    assert.match(fs.readFileSync(path.join(dir, 'src.js'), 'utf8'), /WIP/);
    assert.ok(statusSnapshot(dir).has('src.js'));
  } finally {
    cleanup();
  }
});

test('safeRollback kirli dosyaya dokunmaz, temiz-değişeni geri alır', () => {
  const { dir, cleanup } = tmpDir('updeps-git-');
  try {
    const { git: g } = initGitRepo(dir);
    fs.writeFileSync(path.join(dir, 'lock.json'), 'A\n');
    fs.writeFileSync(path.join(dir, 'wip.txt'), 'committed\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'base']);

    fs.writeFileSync(path.join(dir, 'wip.txt'), 'user edit\n'); // önceden kirli
    const before = statusSnapshot(dir);

    // komut ikisini de değiştirir
    fs.writeFileSync(path.join(dir, 'lock.json'), 'B\n');
    fs.writeFileSync(path.join(dir, 'wip.txt'), 'command clobber\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'created by command\n');
    const after = statusSnapshot(dir);

    safeRollback(dir, before, after);

    assert.equal(fs.readFileSync(path.join(dir, 'lock.json'), 'utf8'), 'A\n'); // geri alındı
    assert.equal(fs.readFileSync(path.join(dir, 'wip.txt'), 'utf8'), 'command clobber\n'); // dokunulmadı
    assert.ok(fs.existsSync(path.join(dir, 'new.txt'))); // takipsiz, silinmedi
  } finally {
    cleanup();
  }
});

test('hashPaths: aynı status koduyla kalan ama içeriği değişen dosyayı yakalar', () => {
  const { dir, cleanup } = tmpDir('updeps-git-');
  try {
    const { git: g } = initGitRepo(dir);
    fs.writeFileSync(path.join(dir, 'lock.json'), '{"v":1}\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'add lock']);

    // kullanıcı zaten kirli bırakmış
    fs.writeFileSync(path.join(dir, 'lock.json'), '{"v":2}\n');
    const before = statusSnapshot(dir);
    const dirtyPaths = [...before.keys()].filter((p) => before.get(p)[0] !== '?');
    assert.deepEqual(dirtyPaths, ['lock.json']);
    const hashesBefore = hashPaths(dir, dirtyPaths);

    // "komut" aynı (zaten kirli) dosyayı bir kez daha değiştirir — status kodu ( M) aynı kalır
    fs.writeFileSync(path.join(dir, 'lock.json'), '{"v":3}\n');
    const after = statusSnapshot(dir);
    assert.equal(before.get('lock.json'), after.get('lock.json')); // diffSnapshots bunu göremezdi
    const { tracked, untracked } = diffSnapshots(before, after);
    assert.deepEqual([...tracked, ...untracked], []); // mevcut mekanizma körü

    const hashesAfter = hashPaths(dir, dirtyPaths);
    const touched = dirtyPaths.filter((p) => hashesAfter.get(p) !== hashesBefore.get(p));
    assert.deepEqual(touched, ['lock.json']);
  } finally {
    cleanup();
  }
});

test('hashPaths: dosya değişmemişse aynı hash döner', () => {
  const { dir, cleanup } = tmpDir('updeps-git-');
  try {
    const { git: g } = initGitRepo(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'sabit\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'add a']);
    const h1 = hashPaths(dir, ['a.txt']);
    const h2 = hashPaths(dir, ['a.txt']);
    assert.equal(h1.get('a.txt'), h2.get('a.txt'));
    assert.ok(h1.get('a.txt'));
  } finally {
    cleanup();
  }
});

test('checkPreconditions rebase ortamını yakalar', () => {
  const { dir, cleanup } = tmpDir('updeps-git-');
  try {
    initGitRepo(dir);
    assert.equal(checkPreconditions(dir).ok, true);
    fs.mkdirSync(path.join(dir, '.git', 'rebase-merge'));
    assert.equal(checkPreconditions(dir).ok, false);
  } finally {
    cleanup();
  }
});

test('checkPreconditions git olmayan dizini reddeder', () => {
  const { dir, cleanup } = tmpDir('updeps-git-');
  try {
    assert.equal(checkPreconditions(dir).ok, false);
    assert.equal(checkPreconditions('/nonexistent/xyz').ok, false);
  } finally {
    cleanup();
  }
});

test('upstreamStatus / remoteTip: upstream yok, ahead sayısı, detached', () => {
  const { dir, cleanup } = tmpDir('updeps-git-');
  try {
    const remote = path.join(dir, 'remote.git');
    const work = path.join(dir, 'work');
    fs.mkdirSync(remote);
    git(['init', '-q', '--bare', '-b', 'main'], remote);
    const { git: g } = initGitRepo(work);

    assert.equal(upstreamStatus(work), null); // upstream tanımsız
    assert.equal(remoteTip(work, 'origin', 'main'), null);

    g(['remote', 'add', 'origin', remote]);
    g(['push', '-q', '-u', 'origin', 'main']);
    assert.deepEqual(upstreamStatus(work), { branch: 'main', remote: 'origin', remoteBranch: 'main', ahead: 0 });
    assert.equal(remoteTip(work, 'origin', 'main'), g(['rev-parse', 'HEAD']));

    fs.writeFileSync(path.join(work, 'f.txt'), '1\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'one']);
    fs.writeFileSync(path.join(work, 'f.txt'), '2\n');
    g(['commit', '-aqm', 'two']);
    assert.equal(upstreamStatus(work).ahead, 2);

    // yerel branch adı upstream adından farklı olabilir
    g(['checkout', '-q', '-b', 'feature', '--track', 'origin/main']);
    assert.deepEqual(upstreamStatus(work), { branch: 'feature', remote: 'origin', remoteBranch: 'main', ahead: 0 });

    g(['checkout', '-q', '--detach']);
    assert.equal(upstreamStatus(work), null);
  } finally {
    cleanup();
  }
});
