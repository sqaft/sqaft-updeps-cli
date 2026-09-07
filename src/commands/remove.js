import fs from 'node:fs';
import { styleText } from 'node:util';
import { CONFIG_FILE, resolveHome } from '../paths.js';
import { saveConfig } from '../config.js';

export function commandRemove(args) {
  const sourcePath = args._?.[1];
  const targetPath = args.target || args._?.[2];

  if (!sourcePath) {
    console.error(styleText('red', 'Hata: Silinecek kaynak yol veya paket belirtilmelidir.'));
    console.log('Kullanım: updeps remove <kaynak-path> [hedef-path]');
    process.exit(1);
  }

  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(styleText('yellow', 'Konfigürasyon dosyası bulunamadı.'));
    return;
  }

  let rawConfig;
  try {
    rawConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    console.error(styleText('red', `Konfigürasyon okunamadı: ${err.message}`));
    return;
  }

  rawConfig.repos = rawConfig.repos || [];
  const resolvedSource = resolveHome(sourcePath);
  const repoIndex = rawConfig.repos.findIndex(r => resolveHome(r.path) === resolvedSource || r.name === sourcePath);

  if (repoIndex === -1) {
    console.log(styleText('yellow', `Belirtilen kaynak bulunamadı: ${sourcePath}`));
    return;
  }

  const repo = rawConfig.repos[repoIndex];

  if (targetPath) {
    const resolvedTarget = resolveHome(targetPath);
    const beforeCount = (repo.packages || []).length;
    repo.packages = (repo.packages || []).filter(p => resolveHome(p.path) !== resolvedTarget && p.name !== targetPath);

    if (repo.packages.length < beforeCount) {
      saveConfig(rawConfig, CONFIG_FILE);
      console.log(styleText('green', `✔ Hedef paket kaldırıldı: ${targetPath}`));
    } else {
      console.log(styleText('yellow', `Belirtilen hedef paket bulunamadı: ${targetPath}`));
    }
  } else {
    rawConfig.repos.splice(repoIndex, 1);
    saveConfig(rawConfig, CONFIG_FILE);
    console.log(styleText('green', `✔ Kaynak repo ve tüm ilişkileri kaldırıldı: ${sourcePath}`));
  }
}
