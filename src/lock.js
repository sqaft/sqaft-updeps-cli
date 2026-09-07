import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LOCKS_DIR } from './paths.js';
import { logger } from './logger.js';

/**
 * Filesystem-safe lock directory name for a repo path.
 * @param {string} repoPath
 * @returns {string}
 */
export function lockNameFor(repoPath) {
  const hash = crypto.createHash('sha256').update(repoPath).digest('hex').slice(0, 12);
  const base = path.basename(repoPath).replace(/[^A-Za-z0-9_.-]/g, '_');
  return `${base}-${hash}.lock`;
}

/**
 * Acquires an atomic lock for a repo path using mkdir (no flock on macOS).
 * Retries once per second. A lock whose mtime is older than staleLockSec is
 * treated as abandoned and stolen.
 * @param {string} repoPath
 * @param {object} [options]
 * @param {number} [options.staleLockSec=900]
 * @param {number} [options.waitTimeoutSec=0]  0 = wait indefinitely
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ lockPath: string, release: () => void }>}
 */
export async function acquireLock(repoPath, options = {}) {
  const staleLockSec = options.staleLockSec ?? 900;
  const waitTimeoutSec = options.waitTimeoutSec ?? 0;

  fs.mkdirSync(LOCKS_DIR, { recursive: true });
  const lockPath = path.join(LOCKS_DIR, lockNameFor(repoPath));
  const start = Date.now();

  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(
        path.join(lockPath, 'info.json'),
        JSON.stringify({ pid: process.pid, repoPath, acquiredAt: Date.now() }, null, 2),
        'utf8'
      );
      let released = false;
      return {
        lockPath,
        release() {
          if (released) return;
          released = true;
          try {
            fs.rmSync(lockPath, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      try {
        const ageSec = (Date.now() - fs.statSync(lockPath).mtimeMs) / 1000;
        if (ageSec >= staleLockSec) {
          logger.warn(`[kilit] Bayat kilit temizleniyor (${Math.round(ageSec)}s): ${lockPath}`);
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat
      }

      const elapsed = (Date.now() - start) / 1000;
      if (waitTimeoutSec > 0 && elapsed >= waitTimeoutSec) {
        throw new Error(`Kilit alınamadı (zaman aşımı ${waitTimeoutSec}s): ${repoPath}`);
      }
      if (options.signal?.aborted) {
        throw new Error(`Kilit beklemesi iptal edildi: ${repoPath}`);
      }
      if (Math.round(elapsed) > 0 && Math.round(elapsed) % 15 === 0) {
        logger.info(`[kilit] Bekleniyor (${Math.round(elapsed)}s): ${repoPath}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
