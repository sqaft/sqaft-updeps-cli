import { styleText } from 'node:util';
import { loadConfig } from '../config.js';
import { renderTree, findCycles, derivePackageNames } from '../graph.js';

export function cmdGraph() {
  const config = loadConfig();

  console.log(renderTree(config));
  console.log('');

  console.log(styleText('bold', 'Türetilen {pkgs} listeleri'));
  const seen = new Set();
  for (const repo of config.repos) {
    for (const pkg of repo.packages) {
      if (seen.has(pkg.path)) continue;
      seen.add(pkg.path);
      const names = derivePackageNames(config, pkg.path);
      console.log(`  ${pkg.name}  ${styleText('dim', '←')}  ${names.join(' ')}`);
    }
  }
  console.log('');

  const cycles = findCycles(config);
  if (cycles.length === 0) {
    console.log(styleText('green', '✓ Döngü (cycle) yok.'));
  } else {
    console.log(styleText('yellow', `⚠ ${cycles.length} döngü bulundu:`));
    for (const cycle of cycles) {
      console.log('  ' + cycle.join(' → '));
    }
    console.log(
      styleText(
        'dim',
        'Döngüler yalnızca yol üzerinde bir yerde push: true açıkken sonsuz tetiklemeye yol açar.'
      )
    );
  }
}
