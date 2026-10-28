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
import { createPathMatcher } from '../src/glob.js';

test('only the file the command changed is committed, the dirty file is preserved', () => {
  const { dir, cleanup } = tmpDir('updeps-git-');
  try {
    const { git: g } = initGitRepo(dir);
    fs.writeFileSync(path.join(dir, 'lock.json'), '{"v":1}\n');
    fs.writeFileSync(path.join(dir, 'src.js'), 'export const x = 1;\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'add files']);

    // the user is working on src.js (dirty)
    fs.writeFileSync(path.join(dir, 'src.js'), 'export const x = 2; // WIP\n');

    const before = statusSnapshot(dir);
    assert.ok(before.has('src.js'));

    // the "command" changes lock.json
    fs.writeFileSync(path.join(dir, 'lock.json'), '{"v":2}\n');

    const after = statusSnapshot(dir);
    const { tracked, untracked } = diffSnapshots(before, after);
    const changed = [...tracked, ...untracked];
    assert.deepEqual(changed, ['lock.json']);

    selectiveCommit(dir, changed, 'bump lock');

    // lock.json was committed
    assert.equal(git(['show', '--stat', '--format=%s', 'HEAD'], dir).split('\n')[0], 'bump lock');
    // src.js is still dirty and keeps its WIP content
    assert.match(fs.readFileSync(path.join(dir, 'src.js'), 'utf8'), /WIP/);
    assert.ok(statusSnapshot(dir).has('src.js'));
  } finally {
    cleanup();
  }
});

test('safeRollback leaves the dirty file alone and reverts the clean-then-changed one', () => {
  const { dir, cleanup } = tmpDir('updeps-git-');
  try {
    const { git: g } = initGitRepo(dir);
    fs.writeFileSync(path.join(dir, 'lock.json'), 'A\n');
    fs.writeFileSync(path.join(dir, 'wip.txt'), 'committed\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'base']);

    fs.writeFileSync(path.join(dir, 'wip.txt'), 'user edit\n'); // already dirty beforehand
    const before = statusSnapshot(dir);

    // the command changes both
    fs.writeFileSync(path.join(dir, 'lock.json'), 'B\n');
    fs.writeFileSync(path.join(dir, 'wip.txt'), 'command clobber\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'created by command\n');
    const after = statusSnapshot(dir);

    // all three match commitPaths: the preserved ones are preserved only because they were already dirty or are untracked
    const res = safeRollback(dir, before, after, createPathMatcher(['*.json', '*.txt']));

    assert.equal(fs.readFileSync(path.join(dir, 'lock.json'), 'utf8'), 'A\n'); // reverted
    assert.equal(fs.readFileSync(path.join(dir, 'wip.txt'), 'utf8'), 'command clobber\n'); // untouched
    assert.ok(fs.existsSync(path.join(dir, 'new.txt'))); // untracked, not deleted
    assert.deepEqual(res, { reverted: ['lock.json'], otherFiles: [] });
  } finally {
    cleanup();
  }
});

test('safeRollback leaves a clean-then-changed file outside commitPaths alone and reports it', () => {
  const { dir, cleanup } = tmpDir('updeps-git-');
  try {
    const { git: g } = initGitRepo(dir);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), 'A\n');
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'base\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'base']);

    const before = statusSnapshot(dir);
    fs.writeFileSync(path.join(dir, 'package-lock.json'), 'B\n'); // the command
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'other process\n'); // another process
    fs.writeFileSync(path.join(dir, 'notes.md'), 'note\n'); // another process
    const after = statusSnapshot(dir);

    const res = safeRollback(dir, before, after, createPathMatcher(['package-lock.json']));

    assert.equal(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'), 'A\n');
    assert.equal(fs.readFileSync(path.join(dir, 'src', 'a.js'), 'utf8'), 'other process\n');
    assert.ok(fs.existsSync(path.join(dir, 'notes.md')));
    assert.deepEqual(res.reverted, ['package-lock.json']);
    assert.deepEqual(res.otherFiles.sort(), ['notes.md', 'src/a.js']);
  } finally {
    cleanup();
  }
});

test('hashPaths: catches a file whose content changed but whose status code stayed the same', () => {
  const { dir, cleanup } = tmpDir('updeps-git-');
  try {
    const { git: g } = initGitRepo(dir);
    fs.writeFileSync(path.join(dir, 'lock.json'), '{"v":1}\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'add lock']);

    // the user already left it dirty
    fs.writeFileSync(path.join(dir, 'lock.json'), '{"v":2}\n');
    const before = statusSnapshot(dir);
    const dirtyPaths = [...before.keys()].filter((p) => before.get(p)[0] !== '?');
    assert.deepEqual(dirtyPaths, ['lock.json']);
    const hashesBefore = hashPaths(dir, dirtyPaths);

    // the "command" changes the same (already dirty) file once more — the status code ( M) stays the same
    fs.writeFileSync(path.join(dir, 'lock.json'), '{"v":3}\n');
    const after = statusSnapshot(dir);
    assert.equal(before.get('lock.json'), after.get('lock.json')); // diffSnapshots could not see this
    const { tracked, untracked } = diffSnapshots(before, after);
    assert.deepEqual([...tracked, ...untracked], []); // the existing mechanism is blind to it

    const hashesAfter = hashPaths(dir, dirtyPaths);
    const touched = dirtyPaths.filter((p) => hashesAfter.get(p) !== hashesBefore.get(p));
    assert.deepEqual(touched, ['lock.json']);
  } finally {
    cleanup();
  }
});

test('hashPaths: returns the same hash when the file is unchanged', () => {
  const { dir, cleanup } = tmpDir('updeps-git-');
  try {
    const { git: g } = initGitRepo(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'stable\n');
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

test('checkPreconditions detects a rebase in progress', () => {
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

test('checkPreconditions rejects a directory that is not a git repo', () => {
  const { dir, cleanup } = tmpDir('updeps-git-');
  try {
    assert.equal(checkPreconditions(dir).ok, false);
    assert.equal(checkPreconditions('/nonexistent/xyz').ok, false);
  } finally {
    cleanup();
  }
});

test('upstreamStatus / remoteTip: no upstream, ahead count, detached', () => {
  const { dir, cleanup } = tmpDir('updeps-git-');
  try {
    const remote = path.join(dir, 'remote.git');
    const work = path.join(dir, 'work');
    fs.mkdirSync(remote);
    git(['init', '-q', '--bare', '-b', 'main'], remote);
    const { git: g } = initGitRepo(work);

    assert.equal(upstreamStatus(work), null); // no upstream configured
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

    // the local branch name can differ from the upstream name
    g(['checkout', '-q', '-b', 'feature', '--track', 'origin/main']);
    assert.deepEqual(upstreamStatus(work), { branch: 'feature', remote: 'origin', remoteBranch: 'main', ahead: 0 });

    g(['checkout', '-q', '--detach']);
    assert.equal(upstreamStatus(work), null);
  } finally {
    cleanup();
  }
});
