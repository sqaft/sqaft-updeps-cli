import test from 'node:test';
import assert from 'node:assert/strict';
import { compileGlob, createPathMatcher } from '../src/glob.js';
import { DEFAULT_COMMIT_PATHS } from '../src/config.js';

const matches = (pattern, p) => compileGlob(pattern).test(p);

test('a pattern without / matches the file name at any depth', () => {
  assert.ok(matches('yarn.lock', 'yarn.lock'));
  assert.ok(matches('yarn.lock', 'packages/web/yarn.lock'));
  assert.ok(!matches('yarn.lock', 'yarn.lock.bak'));
  assert.ok(!matches('yarn.lock', 'old-yarn.lock'));
  assert.ok(matches('*.lock', 'a/b/c.lock'));
});

test('a pattern containing or starting with / is anchored to the repo root', () => {
  assert.ok(matches('/package.json', 'package.json'));
  assert.ok(!matches('/package.json', 'apps/web/package.json'));
  assert.ok(matches('apps/*/package.json', 'apps/web/package.json'));
  assert.ok(!matches('apps/*/package.json', 'x/apps/web/package.json'));
  assert.ok(!matches('apps/*/package.json', 'apps/web/sub/package.json'));
});

test('* and ? do not cross /', () => {
  assert.ok(matches('src/*.js', 'src/a.js'));
  assert.ok(!matches('src/*.js', 'src/lib/a.js'));
  assert.ok(matches('src/?.js', 'src/a.js'));
  assert.ok(!matches('src/?.js', 'src/ab.js'));
});

test('** matches zero or more directories', () => {
  assert.ok(matches('gen/**/*.json', 'gen/a.json'));
  assert.ok(matches('gen/**/*.json', 'gen/x/y/a.json'));
  assert.ok(!matches('gen/**/*.json', 'other/gen/a.json'));
  assert.ok(matches('**/composer.lock', 'composer.lock'));
  assert.ok(matches('vendor/**', 'vendor/a/b.php'));
  assert.ok(matches('**', 'any/path/at/all.txt'));
});

test('a pattern ending in / matches everything below that directory', () => {
  assert.ok(matches('generated/', 'generated/a.txt'));
  assert.ok(matches('generated/', 'pkg/generated/a/b.txt'));
  assert.ok(!matches('generated/', 'generated.txt'));
});

test('{a,b} alternatives and regex special characters', () => {
  assert.ok(matches('{yarn,Cargo}.lock', 'yarn.lock'));
  assert.ok(matches('{yarn,Cargo}.lock', 'crates/x/Cargo.lock'));
  assert.ok(!matches('{yarn,Cargo}.lock', 'bun.lock'));
  assert.ok(!matches('a.b', 'axb')); // . is literal
  assert.ok(matches('f(1)+[x].txt', 'f(1)+[x].txt'));
});

test('invalid patterns throw', () => {
  assert.throws(() => compileGlob(''), /empty/);
  assert.throws(() => compileGlob('   '), /empty/);
  assert.throws(() => compileGlob('/'), /just/);
  assert.throws(() => compileGlob('!yarn.lock'), /negation/);
  assert.throws(() => compileGlob('{a,b'), /unclosed/);
  assert.throws(() => compileGlob('a}'), /unmatched/);
  assert.throws(() => compileGlob('{a,{b,c}}'), /nested/);
});

test('the default commitPaths match lockfiles and manifests, not source files', () => {
  const isCommitPath = createPathMatcher(DEFAULT_COMMIT_PATHS);
  for (const p of [
    'package.json',
    'package-lock.json',
    'packages/web/package.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb',
    'composer.lock',
    'crates/core/Cargo.toml',
    'go.sum',
    'Gemfile.lock',
    'uv.lock',
    'ios/App.xcworkspace/xcshareddata/swiftpm/Package.resolved',
    'pubspec.lock'
  ]) {
    assert.ok(isCommitPath(p), p);
  }
  for (const p of ['notes.md', 'src/a.js', 'package.json.bak', '.npmrc', 'README.md', 'tsconfig.json']) {
    assert.ok(!isCommitPath(p), p);
  }
});
