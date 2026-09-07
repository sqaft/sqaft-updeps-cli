import { styleText } from 'node:util';
import { loadConfig } from '../config.js';

export function commandList() {
  const config = loadConfig();

  if (!config.repos || config.repos.length === 0) {
    console.log(styleText('yellow', 'Kayıtlı herhangi bir repo bulunamadı.'));
    console.log('"updeps init" veya "updeps add" ile repo ekleyebilirsiniz.');
    return;
  }

  console.log(styleText(['bold', 'cyan'], `Kayıtlı Kaynak Repolar (${config.repos.length}):\n`));

  for (const repo of config.repos) {
    console.log(styleText('bold', `📦 ${repo.name}`) + styleText('dim', ` (${repo.rawPath || repo.path})`));

    const packages = repo.packages || [];
    if (packages.length === 0) {
      console.log(styleText('dim', '    (Hedef paket tanımlanmamış)'));
    } else {
      for (const pkg of packages) {
        const triggers = styleText('magenta', `[${pkg.triggers.join(', ')}]`);
        const pushStatus = pkg.push ? styleText('green', ' [push: açık]') : styleText('dim', ' [push: kapalı]');
        const branches = pkg.branches?.length ? styleText('dim', ` (branch: ${pkg.branches.join(', ')})`) : '';

        console.log(`  ↳ 🎯 ${styleText('bold', pkg.name)} ${triggers}${pushStatus}${branches}`);
        console.log(styleText('dim', `     Yol: ${pkg.rawPath || pkg.path}`));
        console.log(styleText('dim', `     Komutlar: ${pkg.commands.join(' && ')}`));
      }
    }
    console.log('');
  }
}
