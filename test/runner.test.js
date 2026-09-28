import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers.js';

const { dir, cleanup } = tmpDir('updeps-runner-');
process.env.XDG_STATE_HOME = dir;
process.env.XDG_CONFIG_HOME = dir;

const { rejectReason, targetAccepts, runTarget } = await import('../src/runner.js');
const { resolveConfig } = await import('../src/config.js');

test.after(cleanup);

function g(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

test('rejectReason: manual tetikleyici her zaman kabul edilir', () => {
  const target = { triggers: ['push'], branches: ['main'] };
  assert.equal(rejectReason(target, { trigger: 'manual' }), null);
  assert.equal(targetAccepts(target, { trigger: 'manual' }), true);
});

test('rejectReason: tetikleyici tipi kapalıysa reddeder', () => {
  const target = { triggers: ['push'], branches: [] };
  assert.match(rejectReason(target, { trigger: 'fetch' }), /tetikleyici 'fetch'/);
  assert.equal(targetAccepts(target, { trigger: 'fetch' }), false);
});

test('rejectReason: branch listede değilse reddeder, boş listede her branch geçer', () => {
  const target = { triggers: ['push'], branches: ['main'] };
  assert.match(rejectReason(target, { trigger: 'push', branch: 'develop' }), /branch 'develop'/);
  assert.equal(rejectReason(target, { trigger: 'push', branch: 'main' }), null);

  const noBranchFilter = { triggers: ['push'], branches: [] };
  assert.equal(rejectReason(noBranchFilter, { trigger: 'push', branch: 'anything' }), null);
});

test('runTarget: AbortSignal ile iptal edilen komut "failed" sonuçlanır ve kilit bırakılır', async () => {
  const target = path.join(dir, 'abort-target');
  fs.mkdirSync(target);
  g(['init', '-q', '-b', 'main'], target);
  g(['config', 'user.email', 't@t.t'], target);
  g(['config', 'user.name', 't'], target);
  fs.writeFileSync(path.join(target, 'f.txt'), 'v1\n');
  g(['add', '-A'], target);
  g(['commit', '-qm', 'init'], target);

  const config = resolveConfig({
    notifications: false,
    defaults: { commandTimeout: 30 },
    repos: [
      {
        path: target, // kaynak == hedef, sadece runTarget'ı doğrudan çağırmak için
        name: 'src',
        packages: [{ path: target, name: 'tgt', commands: ['sleep 5'] }]
      }
    ]
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);

  const result = await runTarget({
    config,
    target: config.repos[0].packages[0],
    trigger: { trigger: 'manual', sourceName: 'src', sourcePath: target },
    signal: controller.signal
  });

  assert.equal(result.status, 'failed');
  assert.match(result.message, /daemon kapatıldı/);

  // kilit bırakıldı, aynı hedefe hemen yeni bir run başlatılabilir
  const { acquireLock } = await import('../src/lock.js');
  const lock = await acquireLock(target, { waitTimeoutSec: 1 });
  lock.release();
});
