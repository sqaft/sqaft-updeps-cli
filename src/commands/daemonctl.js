import { styleText } from 'node:util';
import { startAgent, stopAgent, restartAgent, runningDaemonPid } from '../daemon.js';
import { tildify } from '../paths.js';

export function cmdStart() {
  try {
    const plist = startAgent();
    console.log(styleText('green', `Daemon başlatıldı. Agent: ${tildify(plist)}`));
    console.log(styleText('dim', 'Durum: updeps status   Loglar: updeps logs -f'));
  } catch (err) {
    console.error(styleText('red', err.message));
    process.exit(1);
  }
}

export function cmdStop() {
  stopAgent();
  console.log(styleText('green', 'Daemon durduruldu.'));
}

export function cmdRestart() {
  try {
    restartAgent();
    const pid = runningDaemonPid();
    console.log(styleText('green', `Daemon yeniden başlatıldı${pid ? ` (pid ${pid})` : ''}.`));
  } catch (err) {
    console.error(styleText('red', err.message));
    process.exit(1);
  }
}
