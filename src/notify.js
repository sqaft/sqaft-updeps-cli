import { spawn, spawnSync } from 'node:child_process';
import { logger } from './logger.js';
import { redact } from './redact.js';

let _hasTerminalNotifier = null;
function hasTerminalNotifier() {
  if (_hasTerminalNotifier === null) {
    _hasTerminalNotifier =
      spawnSync('command', ['-v', 'terminal-notifier'], { shell: true }).status === 0;
  }
  return _hasTerminalNotifier;
}

/**
 * Builds the terminal-notifier argv for a notification (pure, testable).
 * @param {{ type:'ok'|'fail', title:string, message:string }} opts
 * @returns {string[]}
 */
export function terminalNotifierArgs({ type, title, message }) {
  const subtitle = type === 'fail' ? '❌ hata var' : '✅ tamamlandı';
  const sound = type === 'fail' ? 'Basso' : 'Glass';
  return ['-title', title, '-subtitle', subtitle, '-message', message, '-sound', sound];
}

/**
 * Sends a single macOS notification. All values are passed via argv, never a shell.
 * Fails silently if no notifier is available.
 * @param {object} opts
 * @param {'ok'|'fail'} opts.type
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {boolean} [opts.enabled=true]
 */
export function sendNotification({ type, title, message, enabled = true }) {
  if (!enabled) return;
  title = redact(title);
  message = redact(message);

  const subtitle = type === 'fail' ? '❌ hata var' : '✅ tamamlandı';
  const sound = type === 'fail' ? 'Basso' : 'Glass';

  try {
    if (hasTerminalNotifier()) {
      spawn('terminal-notifier', terminalNotifierArgs({ type, title, message }), {
        stdio: 'ignore',
        detached: true
      }).unref();
      return;
    }
    const script =
      `display notification ${asString(message)} with title ${asString(title)} ` +
      `subtitle ${asString(subtitle)} sound name ${asString(sound)}`;
    spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true }).unref();
  } catch (err) {
    logger.debug(`Bildirim gönderilemedi: ${err.message}`);
  }
}

/**
 * Quotes a string as an AppleScript string literal.
 * @param {string} s
 */
function asString(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Asks SwiftBar to refresh the updeps plugin, if SwiftBar is around.
 */
export function refreshSwiftBar() {
  try {
    spawn('open', ['-g', 'swiftbar://refreshplugin?name=updeps'], { stdio: 'ignore' }).unref();
  } catch {
    /* ignore */
  }
}
