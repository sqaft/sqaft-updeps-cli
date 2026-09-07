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
  checkPreconditions
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
