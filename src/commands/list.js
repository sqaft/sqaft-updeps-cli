import { styleText } from 'node:util';
import { loadConfig } from '../config.js';
import { derivePackageNames } from '../graph.js';

export function cmdList() {
  const config = loadConfig();
  if (config.repos.length === 0) {
    console.log('Config boş — henüz kaynak repo tanımlı değil.');
    return;
  }

  for (const repo of config.repos) {
    console.log(styleText('bold', repo.name) + styleText('dim', `  ${repo.rawPath}`));
    if (repo.packages.length === 0) {
      console.log(styleText('dim', '  (bağımlı paket yok)'));
    }
    for (const pkg of repo.packages) {
      const flags = [
        pkg.triggers.join(','),
        pkg.push ? 'push' : 'commit-only',
        pkg.dirtyPolicy
      ].join(' · ');
      console.log(`  → ${pkg.name}  ${styleText('dim', `[${flags}]`)}`);
      console.log(styleText('dim', `      ${pkg.commands.join(' && ')}`));
    }
    console.log('');
  }

  console.log(styleText('dim', 'Her hedefin güncelleme komutuna geçecek paket listesi ({pkgs}):'));
  const seen = new Set();
  for (const repo of config.repos) {
    for (const pkg of repo.packages) {
      if (seen.has(pkg.path)) continue;
      seen.add(pkg.path);
      console.log(styleText('dim', `  ${pkg.name}: `) + derivePackageNames(config, pkg.path).join(' '));
    }
  }
}
