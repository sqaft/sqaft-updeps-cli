import fs from 'node:fs';
import { styleText } from 'node:util';
import { CONFIG_FILE, CONFIG_DIR } from '../paths.js';
import { createDefaultConfig, saveConfig } from '../config.js';

export function commandInit(args = {}) {
  const force = Boolean(args.force);

  if (fs.existsSync(CONFIG_FILE) && !force) {
    console.log(styleText('yellow', `Konfigürasyon dosyası zaten mevcut: ${CONFIG_FILE}`));
    console.log('Üzerine yazmak için --force bayrağını kullanabilirsiniz.');
    return;
  }

  const sample = createDefaultConfig();
  saveConfig(sample, CONFIG_FILE);

  console.log(styleText('green', `✔ Konfigürasyon dosyası oluşturuldu:`));
  console.log(`  ${CONFIG_FILE}`);
  console.log('\nDosyayı kendi projelerinize ve paket yöneticisi komutlarınıza göre düzenleyebilirsiniz.');
}
