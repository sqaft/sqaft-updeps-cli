import fs from 'node:fs';
import net from 'node:net';
import { CONTROL_ADDRESS } from './paths.js';

/**
 * The daemon's control channel: a Unix domain socket (macOS, Linux) or a named
 * pipe (Windows). A client connects, writes one JSON line `{"command": "..."}`
 * and gets one JSON line back: `{"ok": true, ...}` or `{"ok": false, "error": "..."}`.
 * It is how the CLI stops a daemon that runs without a service manager —
 * Windows has no SIGTERM a process could handle.
 */

/**
 * Starts listening. A socket file left behind by a crashed daemon is removed
 * first; only one daemon runs at a time (pid file check), so it is never live.
 * @param {Record<string, () => object | Promise<object>>} handlers command name -> reply fields
 * @param {string} [address]
 * @returns {Promise<net.Server>}
 */
export async function startControlServer(handlers, address = CONTROL_ADDRESS) {
  if (process.platform !== 'win32') fs.rmSync(address, { force: true });

  const server = net.createServer((socket) => {
    let buf = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.on('error', () => {
      /* client went away */
    });
    socket.on('data', async (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1 || handled) return;
      handled = true;
      let reply;
      try {
        const { command } = JSON.parse(buf.slice(0, nl));
        const handler = Object.hasOwn(handlers, command) ? handlers[command] : null;
        reply = handler ? { ok: true, ...(await handler()) } : { ok: false, error: `unknown command: ${command}` };
      } catch (err) {
        reply = { ok: false, error: err.message };
      }
      socket.end(JSON.stringify(reply) + '\n');
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (process.platform !== 'win32') fs.chmodSync(address, 0o600);
  return server;
}

/**
 * Sends one command to the daemon.
 * @param {string} command
 * @param {{ timeoutMs?: number, address?: string }} [opts]
 * @returns {Promise<object|null>} the reply, or null when no daemon answered
 */
export function sendControl(command, { timeoutMs = 3000, address = CONTROL_ADDRESS } = {}) {
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const socket = net.connect(address);
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ command }) + '\n'));
    socket.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      try {
        finish(JSON.parse(buf.slice(0, nl)));
      } catch {
        finish(null);
      }
    });
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
  });
}
