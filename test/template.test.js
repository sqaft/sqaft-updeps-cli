import test from 'node:test';
import assert from 'node:assert/strict';
import { interpolateCommand, interpolateMessage } from '../src/template.js';
import { shellQuote } from '../src/exec.js';

const base = {
  pkg: '@acme/api',
  pkgList: ['@acme/api', '@acme/sdk'],
  sha: 'abcdef1234567890',
  sourcePath: '/src',
  sourceBranch: 'main',
  targetPath: '/tgt',
  targetBranch: 'main',
  shell: '/bin/sh'
};

test('{pkgs} in a command: multiple packages, scoped names', () => {
  const out = interpolateCommand('yarn upgrade {pkgs}', base);
  assert.equal(out, 'yarn upgrade @acme/api @acme/sdk');
});

test('a package name containing a space is shell-quoted', () => {
  const out = interpolateCommand('npm update {pkgs}', { ...base, pkgList: ['weird name'] });
  assert.equal(out, "npm update 'weird name'");
});

test('{pkgs} is quoted for the shell the command runs in', () => {
  const vars = { ...base, pkgList: ['weird name', '@acme/api'] };
  assert.equal(interpolateCommand('npm update {pkgs}', { ...vars, shell: 'cmd.exe' }), 'npm update "weird name" @acme/api');
  assert.equal(interpolateCommand('npm update {pkgs}', { ...vars, shell: 'pwsh' }), "npm update 'weird name' '@acme/api'");
});

test('{sha} is shortened to 7 characters, {bumps} is combined', () => {
  assert.equal(interpolateCommand('echo {sha}', base), 'echo abcdef1');
  assert.equal(interpolateMessage('bump {bumps}', base), 'bump @acme/api@abcdef1');
});

test('{pkgs} in a commit message is unquoted and comma-separated', () => {
  assert.equal(
    interpolateMessage('package updated {pkgs}', base),
    'package updated @acme/api, @acme/sdk'
  );
});

test('{bumps} lists multiple sources (a coalesced job)', () => {
  const multi = {
    ...base,
    sources: [
      { name: '@acme/api', sha: 'aaaaaaa1234567' },
      { name: '@acme/sdk', sha: 'bbbbbbb1234567' }
    ]
  };
  assert.equal(
    interpolateMessage('bump {bumps}', multi),
    'bump @acme/api@aaaaaaa, @acme/sdk@bbbbbbb'
  );
  assert.equal(
    interpolateCommand('echo {bumps}', multi),
    'echo @acme/api@aaaaaaa, @acme/sdk@bbbbbbb'
  );
});

test('an unknown placeholder is preserved', () => {
  assert.equal(interpolateCommand('x {unknown} y', base), 'x {unknown} y');
});

test('shellQuote basic behavior', () => {
  assert.equal(shellQuote('@scope/pkg'), '@scope/pkg');
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  assert.equal(shellQuote(''), "''");
});
