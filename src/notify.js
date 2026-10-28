import { spawn, spawnSync } from 'node:child_process';
import { logger } from './logger.js';
import { redact } from './redact.js';

/**
 * Fire-and-forget spawn for a best-effort side effect (notification, SwiftBar
 * refresh). The executable not existing surfaces as an *async* 'error' event
 * on the child, not a thrown exception — an unhandled one crashes the whole
 * process. Swallow it here so a missing notifier never takes the daemon down.
 * On Windows `detached` would give the child a console of its own, so it is
 * only used elsewhere; `windowsHide` keeps PowerShell from opening a window.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 */
function spawnDetached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    windowsHide: true,
    ...opts
  });
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

/** @param {'ok'|'fail'} type */
function subtitleOf(type) {
  return type === 'fail' ? '❌ failed' : '✅ done';
}

/**
 * Builds the terminal-notifier argv for a notification (pure, testable).
 * @param {{ type:'ok'|'fail', title:string, message:string }} opts
 * @returns {string[]}
 */
export function terminalNotifierArgs({ type, title, message }) {
  const sound = type === 'fail' ? 'Basso' : 'Glass';
  return ['-title', title, '-subtitle', subtitleOf(type), '-message', message, '-sound', sound];
}

/**
 * Builds the notify-send (libnotify, Linux) argv for a notification (pure, testable).
 * @param {{ type:'ok'|'fail', title:string, message:string }} opts
 * @returns {string[]}
 */
export function notifySendArgs({ type, title, message }) {
  return [
    '--app-name=updeps',
    `--icon=${type === 'fail' ? 'dialog-error' : 'dialog-information'}`,
    '--',
    `${title} — ${subtitleOf(type)}`,
    message
  ];
}

/**
 * Builds the PowerShell script that shows a Windows toast notification (pure,
 * testable). The texts go into single-quoted PowerShell strings and the toast
 * XML, escaped for both. The toast is attributed to Windows PowerShell, whose
 * app id is registered on every Windows 10/11 install.
 * @param {{ type:'ok'|'fail', title:string, message:string }} opts
 * @returns {string}
 */
export function windowsToastScript({ type, title, message }) {
  const xmlText = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const toast =
    '<toast><visual><binding template="ToastGeneric">' +
    `<text>${xmlText(title)}</text><text>${xmlText(subtitleOf(type))}</text><text>${xmlText(message)}</text>` +
    '</binding></visual></toast>';
  const psString = (s) => "'" + s.replace(/'/g, "''") + "'";
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml(${psString(toast)})`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    "$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)'
  ].join('\n');
}

/**
 * Sends a single desktop notification: terminal-notifier or osascript on
 * macOS, notify-send on Linux, a PowerShell toast on Windows. All values are
 * passed via argv (or an encoded PowerShell script), never a shell.
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

  try {
    if (process.platform === 'win32') {
      const encoded = Buffer.from(windowsToastScript({ type, title, message }), 'utf16le').toString('base64');
      spawnDetached('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
      return;
    }
    if (process.platform !== 'darwin') {
      spawnDetached('notify-send', notifySendArgs({ type, title, message }));
      return;
    }
    if (hasTerminalNotifier()) {
      spawnDetached('terminal-notifier', terminalNotifierArgs({ type, title, message }));
      return;
    }
    const sound = type === 'fail' ? 'Basso' : 'Glass';
    const script =
      `display notification ${asString(message)} with title ${asString(title)} ` +
      `subtitle ${asString(subtitleOf(type))} sound name ${asString(sound)}`;
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
 * Asks SwiftBar to refresh the updeps plugin, if SwiftBar is around (macOS only).
 */
export function refreshMenubar() {
  if (process.platform !== 'darwin') return;
  try {
    spawnDetached('open', ['-g', 'swiftbar://refreshplugin?name=updeps'], { detached: false });
  } catch {
    /* ignore */
  }
}
