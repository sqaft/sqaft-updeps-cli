#!/usr/bin/env node

import { parseArgs, styleText } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { commandInit } from '../src/commands/init.js';
import { commandList } from '../src/commands/list.js';
import { commandGraph } from '../src/commands/graph.js';
import { commandAdd } from '../src/commands/add.js';
import { commandRemove } from '../src/commands/remove.js';
import { commandRun } from '../src/commands/run.js';
import { commandStatus } from '../src/commands/status.js';
import { commandDoctor } from '../src/commands/doctor.js';
import { commandLogs } from '../src/commands/logs.js';
import { commandMenubar, commandClearErrors } from '../src/commands/menubar.js';
import {
  runDaemonProcess,
  startLaunchDaemon,
  stopLaunchDaemon
} from '../src/daemon.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgJsonPath = path.resolve(__dirname, '../package.json');
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

function printHelp() {
  console.log(`
${styleText(['bold', 'cyan'], '@sqaft/updeps-cli')} v${pkg.version}
${styleText('dim', 'Git push sonrası bağımlı repoları otomatik güncelleyen CLI aracı')}

${styleText('bold', 'Kullanım:')}
  updeps <komut> [seçenekler]

${styleText('bold', 'Komutlar:')}
  ${styleText('green', 'init')}                            Örnek config.json dosyası oluşturur
  ${styleText('green', 'list')}                            Tanımlı repo ve bağımlılıkları listeler
  ${styleText('green', 'graph')}                           Bağımlılık ilişkilerini ASCII ağacı olarak gösterir
  ${styleText('green', 'add <kaynak> --target <hedef>')}   Yeni bir bağımlılık ilişkisi ekler
  ${styleText('green', 'remove <kaynak> [hedef]')}         Bir ilişkiyi veya kaynak repoyu siler
  ${styleText('green', 'run [kaynak] [--dry-run]')}        Bağımlılık güncellemesini manuel tetikler
  ${styleText('green', 'status')}                          Daemon durumu ve bekleyen push'ları gösterir
  ${styleText('green', 'doctor')}                          Sistem sağlık kontrolü yapar
  ${styleText('green', 'logs [--follow]')}                 Log dosyasını görüntüler
  ${styleText('green', 'start')}                           launchd arka plan servisini (daemon) başlatır
  ${styleText('green', 'stop')}                            launchd servisini durdurur
  ${styleText('green', 'restart')}                         launchd servisini yeniden başlatır
  ${styleText('green', 'menubar [--install]')}             SwiftBar / xbar çıktısı üretir veya kurar
  ${styleText('green', 'clear-errors')}                    Menü çubuğundaki hata geçmişini temizler

${styleText('bold', 'Seçenekler:')}
  -h, --help               Yardım mesajını gösterir
  -v, --version            Sürüm numarasını gösterir
`);
}

async function main() {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0 || rawArgs.includes('-h') || rawArgs.includes('--help') || rawArgs[0] === 'help') {
    printHelp();
    return;
  }

  if (rawArgs.includes('-v') || rawArgs.includes('--version') || rawArgs[0] === 'version') {
    console.log(`v${pkg.version}`);
    return;
  }

  const { values, positionals } = parseArgs({
    args: rawArgs,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      'dry-run': { type: 'boolean' },
      follow: { type: 'boolean', short: 'f' },
      force: { type: 'boolean' },
      target: { type: 'string', short: 't' },
      install: { type: 'boolean' },
      push: { type: 'boolean' }
    },
    allowPositionals: true,
    strict: false
  });

  const command = positionals[0];
  const cmdArgs = { ...values, _: positionals };

  try {
    switch (command) {
      case 'init':
        commandInit(cmdArgs);
        break;
      case 'list':
      case 'ls':
        commandList();
        break;
      case 'graph':
      case 'tree':
        commandGraph();
        break;
      case 'add':
        commandAdd(cmdArgs);
        break;
      case 'remove':
      case 'rm':
        commandRemove(cmdArgs);
        break;
      case 'run':
        await commandRun(cmdArgs);
        break;
      case 'status':
        commandStatus();
        break;
      case 'doctor':
        commandDoctor();
        break;
      case 'logs':
      case 'log':
        commandLogs(cmdArgs);
        break;
      case 'menubar':
        commandMenubar(cmdArgs);
        break;
      case 'clear-errors':
        commandClearErrors();
        break;
      case 'start':
        console.log(styleText('cyan', 'LaunchAgent servisi başlatılıyor...'));
        startLaunchDaemon();
        console.log(styleText('green', '✔ Servis başlatıldı. "updeps status" ile kontrol edebilirsiniz.'));
        break;
      case 'stop':
        console.log(styleText('yellow', 'LaunchAgent servisi durduruluyor...'));
        stopLaunchDaemon();
        console.log(styleText('green', '✔ Servis durduruldu.'));
        break;
      case 'restart':
        console.log(styleText('cyan', 'LaunchAgent servisi yeniden başlatılıyor...'));
        stopLaunchDaemon();
        startLaunchDaemon();
        console.log(styleText('green', '✔ Servis yeniden başlatıldı.'));
        break;
      case 'daemon-run':
        await runDaemonProcess();
        break;
      default:
        console.error(styleText('red', `Bilinmeyen komut: "${command}"`));
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(styleText('red', `Hata: ${err.message}`));
    process.exit(1);
  }
}

main();
