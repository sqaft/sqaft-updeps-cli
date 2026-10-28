#!/usr/bin/env node
import { parseArgs, styleText } from 'node:util';
import { setLevel } from '../src/logger.js';
import { ConfigError } from '../src/config.js';

const USAGE = `updeps — keeps dependent repos up to date

USAGE
  updeps <command> [options]

COMMANDS
  init [--force] [--example]      Create a starter configuration
  list                            List source repos and their targets
  graph                           Dependency tree + cycle check + {pkgs} lists
  add <source> --target <target>  Add a new relationship (--name, --target-name, --command)
  remove <source> [target]        Remove a relationship or a source
  run [source] [--target X]       Run manually (--dry-run)
  retry --failed | <target>       Retry open failures
  push [--dry-run] [--commit=MSG] Push commits in dependency order, wait for the daemon
  status [-w/--watch]             What is running now, open failures, recent runs
  history [--failed] [--repo X]   Full run history ([--since 2d] [-n N] [--json])
  show <group|target>             Full detail of a run (commands, output, commit)
  logs [-f] [-n N]                Raw log
  doctor                          System health check
  start | stop | restart          Control the background service (daemon)
  menubar [--install]             SwiftBar/xbar plugin (macOS)
  reset [--yes] [--keep-daemon]   Delete all data except the config (queue + failures)

GLOBAL OPTIONS
  -h, --help                      Show this help
  -v, --version                   Show the version
  --verbose                       Verbose logging
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
  push: { 'dry-run': { type: 'boolean' }, commit: { type: 'string' } },
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
  reset: { yes: { type: 'boolean', short: 'y' }, 'keep-daemon': { type: 'boolean' } },
  daemon: { supervise: { type: 'boolean' }, detach: { type: 'boolean' } }
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
    case 'daemon': {
      const daemon = await import('../src/daemon.js');
      if (values.detach) return daemon.detachDaemon();
      if (values.supervise) return daemon.runSupervisor();
      return daemon.runDaemon();
    }
    default:
      console.error(styleText('red', `Unknown command: ${command}`));
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
    console.error(styleText('red', `Error: ${err.stack || err.message}`));
  }
  process.exit(1);
});
