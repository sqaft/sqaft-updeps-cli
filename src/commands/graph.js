import { styleText } from 'node:util';
import { loadConfig } from '../config.js';
import { renderTree, findCycles, derivePackageNames } from '../graph.js';

export function cmdGraph() {
  const config = loadConfig();

  console.log(renderTree(config));
  console.log('');

  console.log(styleText('bold', 'Derived {pkgs} lists'));
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
    console.log(styleText('green', '✓ No cycles.'));
  } else {
    console.log(styleText('yellow', `⚠ ${cycles.length} cycle(s) found:`));
    for (const cycle of cycles) {
      console.log('  ' + cycle.join(' → '));
    }
    console.log(
      styleText(
        'dim',
        'Cycles cause endless triggering only when push: true is set somewhere along the path.'
      )
    );
  }
}
