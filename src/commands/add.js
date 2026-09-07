import fs from 'node:fs';
import path from 'node:path';
import { styleText } from 'node:util';
import { loadConfig, saveConfig, createDefaultConfig } from '../config.js';
import { CONFIG_FILE, resolveHome } from '../paths.js';

export function commandAdd(args) {
  const sourcePath = args._?.[1];
  const targetPath = args.target;

  if (!sourcePath || !targetPath) {
    console.error(styleText('red', 'Hata: Kaynak ve hedef yollar belirtilmelidir.'));
    console.log('Kullanım: updeps add <kaynak-path> --target <hedef-path>');
    process.exit(1);
  }

  let rawConfig;
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      rawConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
      rawConfig = createDefaultConfig();
    }
  } else {
    rawConfig = createDefaultConfig();
    rawConfig.repos = [];
  }

  rawConfig.repos = rawConfig.repos || [];

  const resolvedSource = resolveHome(sourcePath);
  const resolvedTarget = resolveHome(targetPath);

  let existingRepo = rawConfig.repos.find(r => resolveHome(r.path) === resolvedSource);
  if (!existingRepo) {
    existingRepo = {
      path: sourcePath,
      packages: []
    };
    rawConfig.repos.push(existingRepo);
  }

  existingRepo.packages = existingRepo.packages || [];
  const existingPkgIndex = existingRepo.packages.findIndex(p => resolveHome(p.path) === resolvedTarget);

  const newPkg = {
    path: targetPath
  };
  if (args.command) {
    newPkg.commands = Array.isArray(args.command) ? args.command : [args.command];
  }
  if (args.push !== undefined) {
    newPkg.push = Boolean(args.push);
  }

  if (existingPkgIndex >= 0) {
    existingRepo.packages[existingPkgIndex] = {
      ...existingRepo.packages[existingPkgIndex],
      ...newPkg
    };
    console.log(styleText('green', `✔ Mevcut ilişki güncellendi:`));
  } else {
    existingRepo.packages.push(newPkg);
    console.log(styleText('green', `✔ Yeni ilişki eklendi:`));
  }

  saveConfig(rawConfig, CONFIG_FILE);
  console.log(`  Kaynak: ${sourcePath}`);
  console.log(`  Hedef:  ${targetPath}`);
}
