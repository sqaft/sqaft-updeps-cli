import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { LOG_FILE, tildify } from '../paths.js';
import { redact } from '../redact.js';

/**
 * @param {{ follow?: boolean, lines?: string|number }} opts
 */
export function cmdLogs(opts = {}) {
  if (!fs.existsSync(LOG_FILE)) {
    console.error(`Log dosyası yok: ${tildify(LOG_FILE)}`);
    process.exit(1);
  }

  const n = parseInt(opts.lines ?? 100, 10) || 100;

  if (opts.follow) {
    // pipe through redaction rather than exec'ing `tail -f` directly
    const child = spawn('tail', ['-n', String(n), '-f', LOG_FILE], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const nl = buf.lastIndexOf('\n');
      if (nl === -1) return;
      process.stdout.write(redact(buf.slice(0, nl + 1)));
      buf = buf.slice(nl + 1);
    });
    child.on('exit', (code) => {
      if (buf) process.stdout.write(redact(buf));
      process.exit(code ?? 0);
    });
    return;
  }

  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
  console.log(redact(lines.slice(-n - 1).join('\n').trimEnd()));
}
