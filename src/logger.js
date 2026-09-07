import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR, LOG_FILE } from './paths.js';

const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_BACKUP_FILES = 3;

/**
 * Ensures log directory exists.
 */
function ensureLogDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/**
 * Rotates log files if max size exceeded.
 */
function rotateLogsIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stats = fs.statSync(LOG_FILE);
    if (stats.size < MAX_LOG_SIZE_BYTES) return;

    for (let i = MAX_BACKUP_FILES - 1; i >= 1; i--) {
      const oldPath = `${LOG_FILE}.${i}`;
      const newPath = `${LOG_FILE}.${i + 1}`;
      if (fs.existsSync(oldPath)) {
        if (i === MAX_BACKUP_FILES - 1) {
          fs.rmSync(newPath, { force: true });
        }
        fs.renameSync(oldPath, newPath);
      }
    }

    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // Ignore rotation errors to avoid crashing logger
  }
}

/**
 * Writes a formatted message to log file and optionally console.
 * @param {'INFO'|'WARN'|'ERROR'|'DEBUG'} level
 * @param {string} message
 * @param {object} [options]
 * @param {boolean} [options.echo=false]
 */
export function log(level, message, options = {}) {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const formatted = `[${timestamp}] [${level.padEnd(5)}] ${message}\n`;

  try {
    ensureLogDir();
    rotateLogsIfNeeded();
    fs.appendFileSync(LOG_FILE, formatted, 'utf8');
  } catch (err) {
    // Fallback to stderr if file append fails
    process.stderr.write(`Log yazma hatası: ${err.message}\n`);
  }

  if (options.echo) {
    if (level === 'ERROR') {
      process.stderr.write(formatted);
    } else {
      process.stdout.write(formatted);
    }
  }
}

export const logger = {
  info: (msg, opts) => log('INFO', msg, opts),
  warn: (msg, opts) => log('WARN', msg, opts),
  error: (msg, opts) => log('ERROR', msg, opts),
  debug: (msg, opts) => log('DEBUG', msg, opts)
};
