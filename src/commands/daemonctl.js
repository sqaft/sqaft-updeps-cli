import { styleText } from 'node:util';
import { startService, stopService, restartService, serviceBackend } from '../service/index.js';
import { runningDaemonPid } from '../daemon.js';
import { tildify } from '../paths.js';
import { serviceProblemLine } from './status.js';

/**
 * How the daemon now runs: the service definition and whether it starts at login.
 * @param {import('../service/index.js').ServiceBackend} backend
 * @returns {string}
 */
function describeBackend(backend) {
  if (!backend.file) {
    return 'No service manager found: it runs as a background process and is not started at login.';
  }
  const label = backend.label[0].toUpperCase() + backend.label.slice(1);
  return `${label}: ${tildify(backend.file)}`;
}

/** Prints the Node the installed service resolves, plus any problem with it. */
function printServiceNode(backend) {
  const service = backend.inspect();
  if (service.node) {
    console.log(styleText('dim', `Node: ${tildify(service.node)} (${service.nodeVersion || 'version unknown'})`));
  }
  const problem = serviceProblemLine(backend, service);
  if (problem) console.log(problem);
}

export async function cmdStart() {
  try {
    const backend = await startService();
    const pid = runningDaemonPid();
    console.log(
      (pid ? styleText('green', `Daemon started (pid ${pid}). `) : styleText('yellow', 'Daemon not up yet; see "updeps logs". ')) +
        describeBackend(backend)
    );
    printServiceNode(backend);
    console.log(styleText('dim', 'Status: updeps status   Logs: updeps logs -f'));
  } catch (err) {
    console.error(styleText('red', err.message));
    process.exit(1);
  }
}

export async function cmdStop() {
  await stopService();
  const backend = serviceBackend();
  console.log(
    styleText('green', 'Daemon stopped.') +
      (backend.atLogin ? styleText('dim', ' It starts again at the next login; "updeps start" starts it now.') : '')
  );
}

export async function cmdRestart() {
  try {
    const backend = await restartService();
    const pid = runningDaemonPid();
    console.log(
      pid
        ? styleText('green', `Daemon restarted (pid ${pid}).`)
        : styleText('yellow', 'Daemon restarted but not up yet; see "updeps logs".')
    );
    printServiceNode(backend);
  } catch (err) {
    console.error(styleText('red', err.message));
    process.exit(1);
  }
}
