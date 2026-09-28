import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig, validateConfig, ConfigError } from '../src/config.js';

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

test('kullanıcının örnek dosyası geçerli', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = JSON.parse(
    readFileSync(new URL('../examples/config.json', import.meta.url), 'utf8')
  );
  assert.doesNotThrow(() => resolveConfig(raw));
});
