import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { validateConfig, resolveConfig, DEFAULT_CONFIG_VALUES } from '../src/config.js';
import { resolveHome } from '../src/paths.js';

describe('Paths & resolveHome', () => {
  it('expands ~ to homedir', () => {
    assert.equal(resolveHome('~'), os.homedir());
    assert.equal(resolveHome('~/workspace/test'), path.join(os.homedir(), 'workspace/test'));
  });

  it('keeps absolute paths as is', () => {
    assert.equal(resolveHome('/tmp/foo'), '/tmp/foo');
  });
});

describe('Config Validation & Resolution', () => {
  it('validates and resolves minimal config with defaults', () => {
    const raw = {
      repos: [
        {
          path: '~/workspace/http',
          packages: [
            {
              path: '~/workspace/client'
            }
          ]
        }
      ]
    };

    const resolved = resolveConfig(raw);
    assert.equal(resolved.notifications, true);
    assert.equal(resolved.defaults.push, false);
    assert.equal(resolved.defaults.commitMessage, 'chore(deps): bump {bumps}');
    assert.equal(resolved.repos.length, 1);

    const repo = resolved.repos[0];
    assert.equal(repo.name, 'http');
    assert.equal(repo.path, path.join(os.homedir(), 'workspace/http'));
    assert.equal(repo.packages.length, 1);

    const pkg = repo.packages[0];
    assert.equal(pkg.name, 'client');
    assert.equal(pkg.path, path.join(os.homedir(), 'workspace/client'));
    assert.deepEqual(pkg.triggers, ['push']);
    assert.equal(pkg.push, false);
    assert.equal(pkg.commitMessage, 'chore(deps): bump {bumps}');
  });

  it('allows overriding defaults per package', () => {
    const raw = {
      repos: [
        {
          path: '/tmp/repo-a',
          name: 'custom-a',
          packages: [
            {
              path: '/tmp/repo-b',
              name: 'custom-b',
              triggers: ['fetch', 'push'],
              push: true,
              commitMessage: 'deps: update {bumps} in {branch}',
              commands: ['cargo update']
            }
          ]
        }
      ],
      defaults: {
        push: false,
        debounceMs: 5000
      }
    };

    const resolved = resolveConfig(raw);
    assert.equal(resolved.defaults.debounceMs, 5000);
    const pkg = resolved.repos[0].packages[0];
    assert.equal(pkg.push, true);
    assert.equal(pkg.commitMessage, 'deps: update {bumps} in {branch}');
    assert.deepEqual(pkg.commands, ['cargo update']);
    assert.deepEqual(pkg.triggers, ['fetch', 'push']);
  });

  it('throws helpful error on invalid config types', () => {
    assert.throws(() => validateConfig(null), /JSON objesi olmalıdır/);
    assert.throws(() => validateConfig({ repos: 'not-array' }), /"repos" bir dizi/);
    assert.throws(() => validateConfig({ repos: [{}] }), /path zorunludur/);
    assert.throws(() => validateConfig({ defaults: { push: 'yes' } }), /boolean/);
    assert.throws(() => validateConfig({ defaults: { commandTimeout: -10 } }), /pozitif bir sayı/);
    assert.throws(() => validateConfig({ defaults: { maxConcurrent: -1 } }), /0 veya pozitif bir sayı/);
    assert.throws(() => validateConfig({ defaults: { globalMaxConcurrent: -1 } }), /0 veya pozitif bir sayı/);
    assert.throws(() => validateConfig({ repos: [{ path: '/tmp/r', maxConcurrent: -1 }] }), /0 veya pozitif bir sayı/);
    assert.throws(() => validateConfig({ repos: [{ path: '/tmp/r', packages: [{ path: '/tmp/p', waitTimeoutSec: -1 }] }] }), /0 veya pozitif bir sayı/);
  });

  it('resolves waitTimeoutSec and globalMaxConcurrent properly', () => {
    const raw = {
      repos: [
        {
          path: '/tmp/repo-1',
          maxConcurrent: 2,
          packages: [
            { path: '/tmp/pkg-default' },
            { path: '/tmp/pkg-custom', waitTimeoutSec: 120 }
          ]
        },
        {
          path: '/tmp/repo-2',
          packages: [
            { path: '/tmp/pkg-2' }
          ]
        }
      ],
      defaults: {
        globalMaxConcurrent: 5,
        maxConcurrent: 1,
        waitTimeoutSec: 0
      }
    };

    const resolved = resolveConfig(raw);
    assert.equal(resolved.defaults.globalMaxConcurrent, 5);
    assert.equal(resolved.defaults.maxConcurrent, 1);
    assert.equal(resolved.defaults.waitTimeoutSec, 0);
    assert.equal(resolved.repos[0].maxConcurrent, 2);
    assert.equal(resolved.repos[1].maxConcurrent, 1);
    assert.equal(resolved.repos[0].packages[0].waitTimeoutSec, 0);
    assert.equal(resolved.repos[0].packages[1].waitTimeoutSec, 120);
  });
});
