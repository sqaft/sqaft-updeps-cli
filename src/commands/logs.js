import fs from 'node:fs';
import { LOG_FILE, tildify } from '../paths.js';
import { redact } from '../redact.js';

/**
 * Prints what is appended to a file from now on, polling its size (portable,
 * unlike `tail -f`). When the file shrinks (truncated by `updeps reset`, or
 * rotated and recreated) it is read again from the start. Output is passed on
 * in whole lines so redaction always sees a complete line.
 * @param {string} file
 * @param {(text: string) => void} write
 */
function follow(file, write) {
  let pos = fs.statSync(file).size;
  let partial = '';
  setInterval(() => {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // between rotation and the next write
    }
    if (size < pos) pos = 0;
    if (size === pos) return;
    const buf = Buffer.alloc(size - pos);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, pos);
    } finally {
      fs.closeSync(fd);
    }
    pos = size;
    partial += buf.toString('utf8');
    const nl = partial.lastIndexOf('\n');
    if (nl === -1) return;
    write(partial.slice(0, nl + 1));
    partial = partial.slice(nl + 1);
  }, 250);
}

/**
 * @param {{ follow?: boolean, lines?: string|number }} opts
 */
export function cmdLogs(opts = {}) {
  if (!fs.existsSync(LOG_FILE)) {
    console.error(`Log file not found: ${tildify(LOG_FILE)}`);
    process.exit(1);
  }

  const n = parseInt(opts.lines ?? 100, 10) || 100;

  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
  console.log(redact(lines.slice(-n - 1).join('\n').trimEnd()));

  if (opts.follow) follow(LOG_FILE, (text) => process.stdout.write(redact(text)));
}
