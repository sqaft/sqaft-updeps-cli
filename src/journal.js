import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './paths.js';
import { redact } from './redact.js';

export const JOURNAL_FILE = path.join(STATE_DIR, 'journal.jsonl');
export const JOURNAL_FILE_1 = path.join(STATE_DIR, 'journal.jsonl.1');
const MAX_JOURNAL_BYTES = 5 * 1024 * 1024;

/**
 * Appends one event as a JSON line. Rotates at MAX_JOURNAL_BYTES.
 * Never throws — logging must not break a run.
 * @param {object} record  will get a `ts` (ISO) if absent
 */
export function appendEvent(record) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    try {
      if (fs.statSync(JOURNAL_FILE).size > MAX_JOURNAL_BYTES) {
        fs.renameSync(JOURNAL_FILE, JOURNAL_FILE_1);
      }
    } catch {
      /* no journal yet */
    }
    const line = redact(JSON.stringify({ ts: new Date().toISOString(), ...record })) + '\n';
    fs.appendFileSync(JOURNAL_FILE, line, 'utf8');
  } catch {
    /* ignore */
  }
}

/**
 * Reads journal events newest-first, optionally across the rotated file.
 * @param {object} [opts]
 * @param {number} [opts.limit=Infinity]      max records to return
 * @param {(rec: object) => boolean} [opts.filter]
 * @param {boolean} [opts.includeRotated=true]
 * @returns {object[]}
 */
export function readEvents({ limit = Infinity, filter, includeRotated = true } = {}) {
  const out = [];
  const files = includeRotated ? [JOURNAL_FILE, JOURNAL_FILE_1] : [JOURNAL_FILE];

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = lines[i].trim();
      if (!raw) continue;
      let rec;
      try {
        rec = JSON.parse(raw);
      } catch {
        continue;
      }
      if (filter && !filter(rec)) continue;
      out.push(rec);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Parses a `--since` value: `30m`, `2h`, `3d`, `1w`, or an ISO date.
 * @param {string} value
 * @returns {number} epoch ms, or 0 if unparseable
 */
export function parseSince(value) {
  if (!value) return 0;
  const m = String(value).match(/^(\d+)\s*(m|h|d|w)$/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2].toLowerCase()];
    return Date.now() - n * unit;
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}
