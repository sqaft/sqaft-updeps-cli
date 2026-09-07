import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { LOG_FILE, tildify } from '../paths.js';

/**
 * @param {{ follow?: boolean, lines?: string|number }} opts
 */
export function cmdLogs(opts = {}) {
  if (!fs.existsSync(LOG_FILE)) {
    console.error(`Log dosyası yok: ${tildify(LOG_FILE)}`);
    process.exit(1);
  }

  const n = parseInt(opts.lines ?? opts.n ?? 100, 10) || 100;

  if (opts.follow) {
    const child = spawn('tail', ['-n', String(n), '-f', LOG_FILE], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
  console.log(lines.slice(-n - 1).join('\n').trimEnd());
}
