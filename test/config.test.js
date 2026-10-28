import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig, validateConfig, collectWarnings, ConfigError, DEFAULT_COMMIT_PATHS } from '../src/config.js';

test('an invalid root type gives a clear error', () => {
  assert.throws(() => validateConfig([]), ConfigError);
  assert.throws(() => validateConfig(null), /root/);
});

test('the offending field path appears in the message', () => {
  assert.throws(
    () => validateConfig({ repos: [{ path: '~/a', packages: [{ path: '~/b', commandTimeout: -1 }] }] }),
    /repos\[0\]\.packages\[0\]\.commandTimeout/
  );
});

test('an invalid trigger is rejected', () => {
  assert.throws(
    () => validateConfig({ defaults: { triggers: ['deploy'] } }),
    /defaults\.triggers\[0\]/
  );
});

test('defaults are inherited by the target, a package overrides them', () => {
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

test('coalesce is on by default and can be overridden per package', () => {
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

test('defaults.coalesce: false is inherited by every package', () => {
  const cfg = resolveConfig({
    defaults: { coalesce: false },
    repos: [{ path: '~/src', name: 'src', packages: [{ path: '~/t1', name: 't1' }] }]
  });
  assert.equal(cfg.repos[0].packages[0].coalesce, false);
});

test('coalesce is rejected when not a boolean', () => {
  assert.throws(() => validateConfig({ defaults: { coalesce: 'yes' } }), /defaults\.coalesce/);
  assert.throws(
    () => validateConfig({ repos: [{ path: '~/a', packages: [{ path: '~/b', coalesce: 1 }] }] }),
    /repos\[0\]\.packages\[0\]\.coalesce/
  );
});

test('an unknown field (typo) does not throw, it is returned as a warning', () => {
  const raw = {
    defaults: { comands: ['npm update {pkgs}'] }, // typo for 'commands'
    repos: [
      {
        path: '~/a',
        packages: [{ path: '~/b', comand: 'npm update' }] // typo for 'commands'
      }
    ]
  };
  // structurally valid, does not throw
  assert.doesNotThrow(() => validateConfig(raw));

  const warnings = collectWarnings(raw);
  assert.ok(warnings.some((w) => w.includes('defaults.comands')));
  assert.ok(warnings.some((w) => w.includes('repos[0].packages[0].comand')));

  const cfg = resolveConfig(raw);
  assert.deepEqual(cfg.warnings, warnings);
  // the misspelled field is ignored, the default command is used
  assert.deepEqual(cfg.repos[0].packages[0].commands, ['npm update {pkgs} --no-audit --no-fund']);
});

test('known fields produce no warnings', () => {
  const warnings = collectWarnings({
    notifications: true,
    defaults: { commands: ['x'], coalesce: false },
    repos: [{ path: '~/a', name: 'a', packages: [{ path: '~/b', push: true }] }]
  });
  assert.deepEqual(warnings, []);
});

test('fields starting with _ (for comments) are ignored', () => {
  const warnings = collectWarnings({ _comment: 'not', defaults: { _note: 'x' } });
  assert.deepEqual(warnings, []);
});

test('~ expands to the home directory', () => {
  const cfg = resolveConfig({ repos: [{ path: '~/workspace/x', name: 'x', packages: [] }] });
  assert.equal(cfg.repos[0].path, path.join(os.homedir(), 'workspace/x'));
});

test('the folder name is used when name is omitted', () => {
  const cfg = resolveConfig({ repos: [{ path: '~/workspace/my-lib', packages: [{ path: '~/workspace/my-app' }] }] });
  assert.equal(cfg.repos[0].name, 'my-lib');
  assert.equal(cfg.repos[0].packages[0].name, 'my-app');
});

test('repo-level branches are inherited by the target', () => {
  const cfg = resolveConfig({
    repos: [{ path: '~/a', name: 'a', branches: ['develop'], packages: [{ path: '~/b', name: 'b' }] }]
  });
  assert.deepEqual(cfg.repos[0].packages[0].branches, ['develop']);
});

test('the example config file is valid', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = JSON.parse(
    readFileSync(new URL('../examples/config.json', import.meta.url), 'utf8')
  );
  assert.doesNotThrow(() => resolveConfig(raw));
});

test('squash is on by default and can be overridden in defaults and per package', () => {
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

test('commitPaths: default list, overridden in defaults and per target (a target list replaces the default)', () => {
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

test('commitPaths: invalid values are rejected with the field path', () => {
  const pkg = (commitPaths) => ({ repos: [{ path: '~/a', packages: [{ path: '~/b', commitPaths }] }] });

  assert.throws(() => validateConfig({ defaults: { commitPaths: 'yarn.lock' } }), /defaults\.commitPaths: /);
  assert.throws(() => validateConfig({ defaults: { commitPaths: [] } }), /defaults\.commitPaths: must be an array of strings \(string\[\]\) with at least one/);
  assert.throws(() => validateConfig(pkg(['yarn.lock', 42])), /repos\[0\]\.packages\[0\]\.commitPaths\[1\]/);
  assert.throws(() => validateConfig(pkg(['  '])), /packages\[0\]\.commitPaths\[0\]/);
  assert.throws(() => validateConfig(pkg(['!yarn.lock'])), /commitPaths\[0\].*negation/);
  assert.throws(() => validateConfig(pkg(['{a,b'])), /commitPaths\[0\].*unclosed/);
  assert.throws(() => validateConfig(pkg(['/'])), ConfigError);
  assert.throws(() => resolveConfig(pkg({ glob: 'x' })), /packages\[0\]\.commitPaths/);

  assert.doesNotThrow(() => validateConfig(pkg(['**/*.lock', 'apps/*/package.json', '{go.mod,go.sum}'])));
});
