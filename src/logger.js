import fs from 'node:fs';
import path from 'node:path';
import { styleText } from 'node:util';
import { LOG_FILE, LOGS_DIR } from './paths.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** @type {'debug'|'info'|'warn'|'error'} */
let threshold = process.env.UPDEPS_LOG_LEVEL && LEVELS[process.env.UPDEPS_LOG_LEVEL]
  ? process.env.UPDEPS_LOG_LEVEL
  : 'info';

/** When true, log lines are also written to the console. */
let echoToConsole = false;

/**
 * @param {'debug'|'info'|'warn'|'error'} level
 */
export function setLevel(level) {
  if (LEVELS[level]) threshold = level;
}

/**
 * @param {boolean} value
 */
export function setEcho(value) {
  echoToConsole = Boolean(value);
}

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_BYTES) {
      fs.renameSync(LOG_FILE, path.join(LOGS_DIR, 'updeps.log.1'));
    }
  } catch {
    // no existing log file
  }
}

function writeLine(level, message) {
  if (LEVELS[level] < LEVELS[threshold]) return;

  const timestamp = new Date().toISOString();
  const line = `${timestamp} [${level.toUpperCase()}] ${message}\n`;

  try {
    ensureLogsDir();
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    // never let logging crash the process
  }

  if (echoToConsole) {
    const colored = {
      debug: styleText('dim', message),
      info: message,
      warn: styleText('yellow', message),
      error: styleText('red', message)
    }[level];
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(colored + '\n');
  }
}

export const logger = {
  /** @param {string} m */
  debug: (m) => writeLine('debug', m),
  /** @param {string} m */
  info: (m) => writeLine('info', m),
  /** @param {string} m */
  warn: (m) => writeLine('warn', m),
  /** @param {string} m */
  error: (m) => writeLine('error', m)
};
