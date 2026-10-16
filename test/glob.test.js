import test from 'node:test';
import assert from 'node:assert/strict';
import { compileGlob, createPathMatcher } from '../src/glob.js';
import { DEFAULT_COMMIT_PATHS } from '../src/config.js';

const matches = (pattern, p) => compileGlob(pattern).test(p);

test('/ içermeyen desen her derinlikteki dosya adıyla eşleşir', () => {
  assert.ok(matches('yarn.lock', 'yarn.lock'));
  assert.ok(matches('yarn.lock', 'packages/web/yarn.lock'));
  assert.ok(!matches('yarn.lock', 'yarn.lock.bak'));
  assert.ok(!matches('yarn.lock', 'old-yarn.lock'));
  assert.ok(matches('*.lock', 'a/b/c.lock'));
});

test('/ içeren ya da / ile başlayan desen repo köküne sabitlenir', () => {
  assert.ok(matches('/package.json', 'package.json'));
  assert.ok(!matches('/package.json', 'apps/web/package.json'));
  assert.ok(matches('apps/*/package.json', 'apps/web/package.json'));
  assert.ok(!matches('apps/*/package.json', 'x/apps/web/package.json'));
  assert.ok(!matches('apps/*/package.json', 'apps/web/sub/package.json'));
});

test('* ve ? / karakterini geçmez', () => {
  assert.ok(matches('src/*.js', 'src/a.js'));
  assert.ok(!matches('src/*.js', 'src/lib/a.js'));
  assert.ok(matches('src/?.js', 'src/a.js'));
  assert.ok(!matches('src/?.js', 'src/ab.js'));
});

test('** sıfır veya daha fazla dizinle eşleşir', () => {
  assert.ok(matches('gen/**/*.json', 'gen/a.json'));
  assert.ok(matches('gen/**/*.json', 'gen/x/y/a.json'));
  assert.ok(!matches('gen/**/*.json', 'other/gen/a.json'));
  assert.ok(matches('**/composer.lock', 'composer.lock'));
  assert.ok(matches('vendor/**', 'vendor/a/b.php'));
  assert.ok(matches('**', 'any/path/at/all.txt'));
});

test('/ ile biten desen o dizinin altındaki her şeyle eşleşir', () => {
  assert.ok(matches('generated/', 'generated/a.txt'));
  assert.ok(matches('generated/', 'pkg/generated/a/b.txt'));
  assert.ok(!matches('generated/', 'generated.txt'));
});

test('{a,b} seçenekleri ve regex özel karakterleri', () => {
  assert.ok(matches('{yarn,Cargo}.lock', 'yarn.lock'));
  assert.ok(matches('{yarn,Cargo}.lock', 'crates/x/Cargo.lock'));
  assert.ok(!matches('{yarn,Cargo}.lock', 'bun.lock'));
  assert.ok(!matches('a.b', 'axb')); // . harfiyen
  assert.ok(matches('f(1)+[x].txt', 'f(1)+[x].txt'));
});

test('geçersiz desenler hata fırlatır', () => {
  assert.throws(() => compileGlob(''), /boş/);
  assert.throws(() => compileGlob('   '), /boş/);
  assert.throws(() => compileGlob('/'), /yalnızca/);
  assert.throws(() => compileGlob('!yarn.lock'), /olumsuzlama/);
  assert.throws(() => compileGlob('{a,b'), /kapanmayan/);
  assert.throws(() => compileGlob('a}'), /eşi olmayan/);
  assert.throws(() => compileGlob('{a,{b,c}}'), /iç içe/);
});

test('varsayılan commitPaths kilit dosyaları ve manifestlerle eşleşir, kaynak dosyalarla eşleşmez', () => {
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
