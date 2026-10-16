import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig, validateConfig, collectWarnings, ConfigError, DEFAULT_COMMIT_PATHS } from '../src/config.js';

test('geçersiz kök tipi net hata verir', () => {
  assert.throws(() => validateConfig([]), ConfigError);
  assert.throws(() => validateConfig(null), /kök/);
});

test('hatalı alan yolu mesajda görünür', () => {
  assert.throws(
    () => validateConfig({ repos: [{ path: '~/a', packages: [{ path: '~/b', commandTimeout: -1 }] }] }),
    /repos\[0\]\.packages\[0\]\.commandTimeout/
  );
});

test('geçersiz trigger reddedilir', () => {
  assert.throws(
    () => validateConfig({ defaults: { triggers: ['deploy'] } }),
    /defaults\.triggers\[0\]/
  );
});

test('defaults hedefe miras kalır, paket override eder', () => {
  const cfg = resolveConfig({
    defaults: { commands: ['npm update {pkgs}'], commitMessage: 'x', push: false, commandTimeout: 100 },
    repos: [
      {
        path: '~/src',
        name: 'src',
        packages: [
          { path: '~/t1', name: 't1' },
          { path: '~/t2', name: 't2', commands: ['yarn upgrade {pkgs}'], push: true }
        ]
      }
    ]
  });
  const [t1, t2] = cfg.repos[0].packages;
  assert.deepEqual(t1.commands, ['npm update {pkgs}']);
  assert.equal(t1.push, false);
  assert.equal(t1.commandTimeout, 100);
  assert.deepEqual(t2.commands, ['yarn upgrade {pkgs}']);
  assert.equal(t2.push, true);
});

test('coalesce varsayılan olarak açık, paket düzeyinde override edilebilir', () => {
  const cfg = resolveConfig({
    repos: [
      {
        path: '~/src',
        name: 'src',
        packages: [{ path: '~/t1', name: 't1' }, { path: '~/t2', name: 't2', coalesce: false }]
      }
    ]
  });
  const [t1, t2] = cfg.repos[0].packages;
  assert.equal(t1.coalesce, true);
  assert.equal(t2.coalesce, false);
});

test('defaults.coalesce: false her pakete miras kalır', () => {
  const cfg = resolveConfig({
    defaults: { coalesce: false },
    repos: [{ path: '~/src', name: 'src', packages: [{ path: '~/t1', name: 't1' }] }]
  });
  assert.equal(cfg.repos[0].packages[0].coalesce, false);
});

test('coalesce boolean olmayan değerde reddedilir', () => {
  assert.throws(() => validateConfig({ defaults: { coalesce: 'yes' } }), /defaults\.coalesce/);
  assert.throws(
    () => validateConfig({ repos: [{ path: '~/a', packages: [{ path: '~/b', coalesce: 1 }] }] }),
    /repos\[0\]\.packages\[0\]\.coalesce/
  );
});

test('bilinmeyen alan (yazım hatası) hata vermez, uyarı olarak döner', () => {
  const raw = {
    defaults: { comands: ['npm update {pkgs}'] }, // 'commands' yazım hatası
    repos: [
      {
        path: '~/a',
        packages: [{ path: '~/b', comand: 'npm update' }] // 'commands' yazım hatası
      }
    ]
  };
  // yapısal olarak geçerli, throw etmez
  assert.doesNotThrow(() => validateConfig(raw));

  const warnings = collectWarnings(raw);
  assert.ok(warnings.some((w) => w.includes('defaults.comands')));
  assert.ok(warnings.some((w) => w.includes('repos[0].packages[0].comand')));

  const cfg = resolveConfig(raw);
  assert.deepEqual(cfg.warnings, warnings);
  // yazım hatalı alan yoksayılır, varsayılan komut kullanılır
  assert.deepEqual(cfg.repos[0].packages[0].commands, ['npm update {pkgs} --no-audit --no-fund']);
});

test('bilinen alanlarda uyarı üretilmez', () => {
  const warnings = collectWarnings({
    notifications: true,
    defaults: { commands: ['x'], coalesce: false },
    repos: [{ path: '~/a', name: 'a', packages: [{ path: '~/b', push: true }] }]
  });
  assert.deepEqual(warnings, []);
});

test('_ ile başlayan alanlar (yorum amaçlı) yoksayılır', () => {
  const warnings = collectWarnings({ _comment: 'not', defaults: { _note: 'x' } });
  assert.deepEqual(warnings, []);
});

test('~ ev dizinine genişler', () => {
  const cfg = resolveConfig({ repos: [{ path: '~/workspace/x', name: 'x', packages: [] }] });
  assert.equal(cfg.repos[0].path, path.join(os.homedir(), 'workspace/x'));
});

test('name verilmezse klasör adı kullanılır', () => {
  const cfg = resolveConfig({ repos: [{ path: '~/workspace/my-lib', packages: [{ path: '~/workspace/my-app' }] }] });
  assert.equal(cfg.repos[0].name, 'my-lib');
  assert.equal(cfg.repos[0].packages[0].name, 'my-app');
});

test('repo düzeyi branches hedefe iner', () => {
  const cfg = resolveConfig({
    repos: [{ path: '~/a', name: 'a', branches: ['develop'], packages: [{ path: '~/b', name: 'b' }] }]
  });
  assert.deepEqual(cfg.repos[0].packages[0].branches, ['develop']);
});

test('örnek config dosyası geçerli', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = JSON.parse(
    readFileSync(new URL('../examples/config.json', import.meta.url), 'utf8')
  );
  assert.doesNotThrow(() => resolveConfig(raw));
});

test('squash varsayılan olarak açık, defaults ve paket düzeyinde override edilebilir', () => {
  const on = resolveConfig({ repos: [{ path: '~/s', packages: [{ path: '~/t' }] }] });
  assert.equal(on.repos[0].packages[0].squash, true);

  const off = resolveConfig({
    defaults: { squash: false },
    repos: [{ path: '~/s', packages: [{ path: '~/t1' }, { path: '~/t2', squash: true }] }]
  });
  assert.equal(off.repos[0].packages[0].squash, false);
  assert.equal(off.repos[0].packages[1].squash, true);

  assert.throws(() => validateConfig({ defaults: { squash: 'yes' } }), /defaults\.squash/);
  assert.deepEqual(collectWarnings({ defaults: { squash: true } }), []);
});

test('commitPaths: varsayılan liste, defaults ve hedef düzeyinde override (hedef listesi varsayılanın yerine geçer)', () => {
  const def = resolveConfig({ repos: [{ path: '~/s', packages: [{ path: '~/t' }] }] });
  assert.deepEqual(def.repos[0].packages[0].commitPaths, [...DEFAULT_COMMIT_PATHS]);
  assert.ok(DEFAULT_COMMIT_PATHS.includes('package-lock.json'));
  assert.ok(DEFAULT_COMMIT_PATHS.includes('composer.lock'));

  const cfg = resolveConfig({
    defaults: { commitPaths: ['yarn.lock', 'package.json'] },
    repos: [{ path: '~/s', packages: [{ path: '~/t1' }, { path: '~/t2', commitPaths: ['/deps.lock'] }] }]
  });
  assert.deepEqual(cfg.repos[0].packages[0].commitPaths, ['yarn.lock', 'package.json']);
  assert.deepEqual(cfg.repos[0].packages[1].commitPaths, ['/deps.lock']);

  assert.deepEqual(
    collectWarnings({ defaults: { commitPaths: ['x'] }, repos: [{ path: '~/a', packages: [{ path: '~/b', commitPaths: ['y'] }] }] }),
    []
  );
});

test('commitPaths: geçersiz değerler alan yoluyla reddedilir', () => {
  const pkg = (commitPaths) => ({ repos: [{ path: '~/a', packages: [{ path: '~/b', commitPaths }] }] });

  assert.throws(() => validateConfig({ defaults: { commitPaths: 'yarn.lock' } }), /defaults\.commitPaths: /);
  assert.throws(() => validateConfig({ defaults: { commitPaths: [] } }), /defaults\.commitPaths: en az bir/);
  assert.throws(() => validateConfig(pkg(['yarn.lock', 42])), /repos\[0\]\.packages\[0\]\.commitPaths\[1\]/);
  assert.throws(() => validateConfig(pkg(['  '])), /packages\[0\]\.commitPaths\[0\]/);
  assert.throws(() => validateConfig(pkg(['!yarn.lock'])), /commitPaths\[0\].*olumsuzlama/);
  assert.throws(() => validateConfig(pkg(['{a,b'])), /commitPaths\[0\].*kapanmayan/);
  assert.throws(() => validateConfig(pkg(['/'])), ConfigError);
  assert.throws(() => resolveConfig(pkg({ glob: 'x' })), /packages\[0\]\.commitPaths/);

  assert.doesNotThrow(() => validateConfig(pkg(['**/*.lock', 'apps/*/package.json', '{go.mod,go.sum}'])));
});
