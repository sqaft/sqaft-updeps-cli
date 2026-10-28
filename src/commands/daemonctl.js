import { styleText } from 'node:util';
import { startAgent, stopAgent, restartAgent, runningDaemonPid, inspectAgentPlist } from '../daemon.js';
import { tildify } from '../paths.js';
import { agentProblemLine } from './status.js';

/** Prints the Node the installed agent resolves, plus any problem with it. */
function printAgentNode() {
  const agent = inspectAgentPlist();
  if (agent.node) {
    console.log(styleText('dim', `Node: ${tildify(agent.node)} (${agent.nodeVersion || 'version unknown'})`));
  }
  const problem = agentProblemLine(agent);
  if (problem) console.log(problem);
}

export function cmdStart() {
  try {
    const plist = startAgent();
    console.log(styleText('green', `Daemon started. Agent: ${tildify(plist)}`));
    printAgentNode();
    console.log(styleText('dim', 'Status: updeps status   Logs: updeps logs -f'));
  } catch (err) {
    console.error(styleText('red', err.message));
    process.exit(1);
  }
}

export function cmdStop() {
  stopAgent();
  console.log(styleText('green', 'Daemon stopped.'));
}

export function cmdRestart() {
  try {
    restartAgent();
    const pid = runningDaemonPid();
    console.log(styleText('green', `Daemon restarted${pid ? ` (pid ${pid})` : ''}.`));
    printAgentNode();
  } catch (err) {
    console.error(styleText('red', err.message));
    process.exit(1);
  }
}
