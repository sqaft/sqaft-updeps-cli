import test from 'node:test';
import assert from 'node:assert/strict';
import { interpolateCommand, interpolateMessage } from '../src/template.js';
import { shellQuote } from '../src/exec.js';

const base = {
  pkg: '@umbrella/api',
  pkgList: ['@umbrella/api', '@umbrella/web-client'],
  sha: 'abcdef1234567890',
  sourcePath: '/src',
  sourceBranch: 'main',
  targetPath: '/tgt',
  targetBranch: 'main'
};

test('komutta {pkgs} çoklu paket, scoped adlar', () => {
  const out = interpolateCommand('yarn upgrade {pkgs}', base);
  assert.equal(out, 'yarn upgrade @umbrella/api @umbrella/web-client');
});

test('boşluk içeren paket adı shell-quote edilir', () => {
  const out = interpolateCommand('npm update {pkgs}', { ...base, pkgList: ['weird name'] });
  assert.equal(out, "npm update 'weird name'");
});

test('{sha} 7 haneye kısaltılır, {bumps} birleşik', () => {
  assert.equal(interpolateCommand('echo {sha}', base), 'echo abcdef1');
  assert.equal(interpolateMessage('bump {bumps}', base), 'bump @umbrella/api@abcdef1');
});

test('commit mesajında {pkgs} tırnak yok, virgüllü', () => {
  assert.equal(
    interpolateMessage('package updated {pkgs}', base),
    'package updated @umbrella/api, @umbrella/web-client'
  );
});

test('{bumps} çoklu kaynak (coalesce edilmiş iş) listesi', () => {
  const multi = {
    ...base,
    sources: [
      { name: '@umbrella/api', sha: 'aaaaaaa1234567' },
      { name: '@umbrella/web-client', sha: 'bbbbbbb1234567' }
    ]
  };
  assert.equal(
    interpolateMessage('bump {bumps}', multi),
    'bump @umbrella/api@aaaaaaa, @umbrella/web-client@bbbbbbb'
  );
  assert.equal(
    interpolateCommand('echo {bumps}', multi),
    'echo @umbrella/api@aaaaaaa, @umbrella/web-client@bbbbbbb'
  );
});

test('bilinmeyen placeholder korunur', () => {
  assert.equal(interpolateCommand('x {unknown} y', base), 'x {unknown} y');
});

test('shellQuote temel davranış', () => {
  assert.equal(shellQuote('@scope/pkg'), '@scope/pkg');
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  assert.equal(shellQuote(''), "''");
});
