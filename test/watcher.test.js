import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpDir } from './helpers.js';

const { dir, cleanup } = tmpDir('updeps-watcher-');
process.env.XDG_STATE_HOME = path.join(dir, 'state');
process.env.XDG_CONFIG_HOME = path.join(dir, 'config');

const { CONFIG_FILE, CONFIG_DIR } = await import('../src/paths.js');
const { resolveConfig, saveConfig } = await import('../src/config.js');
const { UpdateQueue } = await import('../src/queue.js');
const { ReflogWatcher } = await import('../src/watcher.js');

test.after(cleanup);

function baseConfig() {
  return { notifications: false, repos: [] };
}

test('config değişince onConfigChange tetiklenir — ardışık atomik yazmalarda da', async () => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  saveConfig(baseConfig());

  let reloads = 0;
  const config = resolveConfig(baseConfig());
  const queue = new UpdateQueue(config, { onGroupDone: () => {} });
  const watcher = new ReflogWatcher(config, queue, () => {
    reloads++;
  });
  watcher.start();
  await sleep(100);

  // saveConfig() replaces the file via write-temp + rename — the case that
  // silently broke a single-file watch.
  saveConfig({ ...baseConfig(), notifications: true });
  for (let i = 0; i < 40 && reloads < 1; i++) await sleep(50);
  assert.equal(reloads, 1, 'ilk değişiklik yeniden yükleme tetiklemeli');

  // Second write: the regression — the watch must still be live.
  saveConfig({ ...baseConfig(), notifications: false });
  for (let i = 0; i < 40 && reloads < 2; i++) await sleep(50);
  assert.equal(reloads, 2, 'ikinci değişiklik de tetiklenmeli');

  await watcher.stop();
});
