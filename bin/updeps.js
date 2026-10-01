#!/usr/bin/env node
import { parseArgs, styleText } from 'node:util';
import { setLevel } from '../src/logger.js';
import { ConfigError } from '../src/config.js';

const USAGE = `updeps — bağımlı repo güncelleyici

KULLANIM
  updeps <komut> [seçenekler]

KOMUTLAR
  init [--force] [--example]      Örnek konfigürasyon oluştur
  list                           Kaynak repoları ve hedeflerini listele
  graph                          Bağımlılık ağacı + döngü kontrolü + {pkgs} listeleri
  add <kaynak> --target <hedef>  Yeni ilişki ekle (--name, --target-name, --command)
  remove <kaynak> [hedef]        İlişkiyi veya kaynağı sil
  run [kaynak] [--target X]      Manuel çalıştır (--dry-run)
  retry --failed | <hedef>      Açık hataları yeniden dene
  push [--dry-run]               Commit'leri bağımlılık sırasıyla push et, daemon'u bekle
  status [-w/--watch]            Şu an ne çalışıyor, açık hatalar, son çalışmalar
  history [--failed] [--repo X]  Tüm işlem geçmişi ([--since 2d] [-n N] [--json])
  show <grup|hedef>             Bir çalışmanın tam detayı (komutlar, çıktı, commit)
  logs [-f] [-n N]               Ham log
  doctor                         Sistem sağlık kontrolü
  start | stop | restart         launchd daemon kontrolü
  menubar [--install]            SwiftBar/xbar eklentisi
  reset [--yes] [--keep-daemon]   Config hariç tüm veriyi sil (kuyruk + hatalar)

GENEL
  -h, --help                     Bu yardım
  -v, --version                  Sürüm
  --verbose                      Ayrıntılı log
`;

const GLOBAL_OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  verbose: { type: 'boolean' }
};

const COMMAND_OPTIONS = {
  init: { force: { type: 'boolean' }, example: { type: 'boolean' } },
  add: {
    target: { type: 'string' },
    name: { type: 'string' },
    'target-name': { type: 'string' },
    command: { type: 'string', multiple: true }
  },
  run: { target: { type: 'string' }, 'dry-run': { type: 'boolean' } },
  retry: { failed: { type: 'boolean' } },
  push: { 'dry-run': { type: 'boolean' } },
  status: { watch: { type: 'boolean', short: 'w' } },
  history: {
    failed: { type: 'boolean' },
    repo: { type: 'string' },
    since: { type: 'string' },
    json: { type: 'boolean' },
    lines: { type: 'string', short: 'n' }
  },
  logs: { follow: { type: 'boolean', short: 'f' }, lines: { type: 'string', short: 'n' } },
  menubar: { install: { type: 'boolean' } },
  reset: { yes: { type: 'boolean', short: 'y' }, 'keep-daemon': { type: 'boolean' } }
};

async function main() {
  const argv = process.argv.slice(2);
  const commandIndex = argv.findIndex((a) => !a.startsWith('-'));
  const command = commandIndex === -1 ? undefined : argv[commandIndex];
  const rest = command === undefined ? argv : argv.slice(0, commandIndex).concat(argv.slice(commandIndex + 1));

  if (!command) {
    const { values } = parseArgs({ args: argv, options: GLOBAL_OPTIONS, allowPositionals: true, strict: false });
    if (values.version) return printVersion();
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const options = { ...GLOBAL_OPTIONS, ...(COMMAND_OPTIONS[command] || {}) };
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options, allowPositionals: true, strict: true });
  } catch (err) {
    console.error(styleText('red', err.message));
    process.exit(1);
  }
  const { values, positionals } = parsed;

  if (values.version) return printVersion();
  if (values.help && command !== 'daemon') {
    console.log(USAGE);
    return;
  }
  if (values.verbose) setLevel('debug');

  switch (command) {
    case 'init':
      return (await import('../src/commands/init.js')).cmdInit(values);
    case 'list':
      return (await import('../src/commands/list.js')).cmdList();
    case 'graph':
      return (await import('../src/commands/graph.js')).cmdGraph();
    case 'add':
      return (await import('../src/commands/add.js')).cmdAdd(positionals, values);
    case 'remove':
      return (await import('../src/commands/remove.js')).cmdRemove(positionals);
    case 'run':
      return (await import('../src/commands/run.js')).cmdRun(positionals, values);
    case 'retry':
      return (await import('../src/commands/retry.js')).cmdRetry(positionals, values);
    case 'push':
      return (await import('../src/commands/push.js')).cmdPush(values);
    case 'status':
      return (await import('../src/commands/status.js')).cmdStatus(values);
    case 'history':
      return (await import('../src/commands/history.js')).cmdHistory(values);
    case 'show':
      return (await import('../src/commands/show.js')).cmdShow(positionals);
    case 'logs':
      return (await import('../src/commands/logs.js')).cmdLogs(values);
    case 'doctor':
      return (await import('../src/commands/doctor.js')).cmdDoctor();
    case 'start':
      return (await import('../src/commands/daemonctl.js')).cmdStart();
    case 'stop':
      return (await import('../src/commands/daemonctl.js')).cmdStop();
    case 'restart':
      return (await import('../src/commands/daemonctl.js')).cmdRestart();
    case 'menubar':
      return (await import('../src/commands/menubar.js')).cmdMenubar(values);
    case 'reset':
      return (await import('../src/commands/reset.js')).cmdReset(values);
    case 'daemon':
      return (await import('../src/daemon.js')).runDaemon();
    default:
      console.error(styleText('red', `Bilinmeyen komut: ${command}`));
      console.log(USAGE);
      process.exit(1);
  }
}

async function printVersion() {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(styleText('red', err.message));
  } else {
    console.error(styleText('red', `Hata: ${err.stack || err.message}`));
  }
  process.exit(1);
});
