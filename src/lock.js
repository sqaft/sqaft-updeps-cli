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

/** Lock dirs this process currently holds — released on daemon shutdown. */
const heldLocks = new Set();

/**
 * True if a pid belongs to a live process on this machine. Locks only ever
 * live under a local state dir, so a same-host check is always valid.
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but owned by another user
  }
}

/**
 * Best-effort removal of every lock this process still holds. Called from the
 * daemon's signal handlers so a restart doesn't strand a lock for `staleLockSec`.
 */
export function releaseHeldLocks() {
  for (const lockPath of heldLocks) {
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  heldLocks.clear();
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
      heldLocks.add(lockPath);
      let released = false;
      return {
        lockPath,
        release() {
          if (released) return;
          released = true;
          heldLocks.delete(lockPath);
          try {
            fs.rmSync(lockPath, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // Owner-dead check: a lock whose creating process is gone (crash, kill,
      // daemon restart mid-run) is abandoned — reclaim it immediately instead
      // of waiting for staleLockSec.
      try {
        const info = JSON.parse(fs.readFileSync(path.join(lockPath, 'info.json'), 'utf8'));
        if (info.pid && !pidAlive(info.pid)) {
          logger.warn(`[kilit] Sahibi (pid ${info.pid}) yok, kilit geri alınıyor: ${lockPath}`);
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        /* no readable info.json yet — fall back to the mtime check below */
      }

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
