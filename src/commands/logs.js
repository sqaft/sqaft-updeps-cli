import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { styleText } from 'node:util';
import { LOG_FILE } from '../paths.js';

export function commandLogs(args) {
  const follow = Boolean(args.follow || args.f);

  if (!fs.existsSync(LOG_FILE)) {
    console.log(styleText('yellow', `Log dosyası henüz oluşmamış: ${LOG_FILE}`));
    return;
  }

  if (follow) {
    const tail = spawn('tail', ['-n', '50', '-f', LOG_FILE], { stdio: 'inherit' });
    tail.on('error', (err) => {
      console.error(`Tail başlatılamadı: ${err.message}`);
    });
  } else {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n');
    const lastLines = lines.slice(-50).join('\n');
    console.log(lastLines);
  }
}
