import { execSync, execFile } from 'node:child_process';

/**
 * Checks if a command exists in PATH.
 * @param {string} cmd
 * @returns {boolean}
 */
function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let hasTerminalNotifier = null;
let hasOsascript = null;

function detectTools() {
  if (hasTerminalNotifier === null) {
    hasTerminalNotifier = commandExists('terminal-notifier');
  }
  if (hasOsascript === null) {
    hasOsascript = commandExists('osascript');
  }
}

/**
 * Sends a macOS desktop notification.
 * @param {object} options
 * @param {'ok'|'fail'} options.type
 * @param {string} options.title
 * @param {string} options.message
 * @param {boolean} [options.enabled=true]
 */
export function sendNotification({ type = 'ok', title, message, enabled = true }) {
  if (!enabled) return;

  detectTools();

  const isOk = type === 'ok';
  const sound = isOk ? 'Glass' : 'Basso';
  const subtitle = isOk ? '✅ Güncelleme Başarılı' : '❌ Güncelleme Başarısız';

  if (hasTerminalNotifier) {
    try {
      execFile('terminal-notifier', [
        '-title', title,
        '-subtitle', subtitle,
        '-message', message,
        '-sound', sound,
        '-group', 'sqaft-updeps'
      ], () => {});
      return;
    } catch {
      // Fallback to osascript
    }
  }

  if (hasOsascript) {
    try {
      const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}" subtitle "${subtitle}" sound name "${sound}"`;
      execFile('osascript', ['-e', script], () => {});
    } catch {
      // Ignore if osascript fails
    }
  }
}
