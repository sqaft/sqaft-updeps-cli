import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/config.js';
import { buildReverseIndex, derivePackageNames, findCycles } from '../src/graph.js';

function load() {
  return import('node:fs').then(({ readFileSync }) =>
    resolveConfig(JSON.parse(readFileSync(new URL('../examples/config.json', import.meta.url), 'utf8')))
  );
}

test('ters indeks hedefi listeleyen tüm kaynakları toplar', async () => {
  const cfg = await load();
  const idx = buildReverseIndex(cfg);
  const appPath = cfg.repos.find((r) => r.name === '@globex/sdk').packages[0].path;
  const names = idx.get(appPath).map((s) => s.name);
  assert.deepEqual(names, ['@acme/api', '@globex/sdk', '@hooli/http-client', '@initech/sdk']);
});

test('umbrella-machine dört paket türetir', async () => {
  const cfg = await load();
  const machinePath = cfg.repos
    .find((r) => r.name === '@umbrella/realtime')
    .packages.find((p) => p.name === 'umbrella-machine').path;
  assert.deepEqual(derivePackageNames(cfg, machinePath), [
    '@umbrella/api',
    '@umbrella/mobile-client',
    '@umbrella/web-client',
    '@umbrella/realtime'
  ]);
});

test('döngü tespit edilir', () => {
  const cfg = resolveConfig({
    repos: [
      { path: '~/a', name: 'a', packages: [{ path: '~/b', name: 'b' }] },
      { path: '~/b', name: 'b', packages: [{ path: '~/a', name: 'a' }] }
    ]
  });
  const cycles = findCycles(cfg);
  assert.equal(cycles.length, 1);
  assert.ok(cycles[0].includes('a') && cycles[0].includes('b'));
});

test('örnek grafikte döngü yok', async () => {
  const cfg = await load();
  assert.deepEqual(findCycles(cfg), []);
});
