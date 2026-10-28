import { spawn, spawnSync } from 'node:child_process';
import { logger } from './logger.js';
import { redact } from './redact.js';

/**
 * Fire-and-forget spawn for a best-effort side effect (notification, SwiftBar
 * refresh). The executable not existing surfaces as an *async* 'error' event
 * on the child, not a thrown exception — an unhandled one crashes the whole
 * process. Swallow it here so a missing terminal-notifier/osascript/open
 * never takes the daemon down.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 */
function spawnDetached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, ...opts });
  child.on('error', () => {
    /* best-effort: missing binary, permission issue, etc. */
  });
  child.unref();
}

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
  const subtitle = type === 'fail' ? '❌ failed' : '✅ done';
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

  const subtitle = type === 'fail' ? '❌ failed' : '✅ done';
  const sound = type === 'fail' ? 'Basso' : 'Glass';

  try {
    if (hasTerminalNotifier()) {
      spawnDetached('terminal-notifier', terminalNotifierArgs({ type, title, message }));
      return;
    }
    const script =
      `display notification ${asString(message)} with title ${asString(title)} ` +
      `subtitle ${asString(subtitle)} sound name ${asString(sound)}`;
    spawnDetached('osascript', ['-e', script]);
  } catch (err) {
    logger.debug(`Could not send notification: ${err.message}`);
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
    spawnDetached('open', ['-g', 'swiftbar://refreshplugin?name=updeps'], { detached: false });
  } catch {
    /* ignore */
  }
}
