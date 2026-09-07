import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LOCKS_DIR } from './paths.js';

/**
 * Returns a filesystem-safe hash for a given repo path.
 * @param {string} repoPath
 * @returns {string}
 */
export function getLockDirName(repoPath) {
  const hash = crypto.createHash('sha256').update(repoPath).digest('hex').slice(0, 16);
  const baseName = path.basename(repoPath).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${baseName}-${hash}.lock`;
}

/**
 * Tries to acquire an atomic lock using mkdir for a given repo path.
 * Retries every second until timeout.
 * @param {string} repoPath
 * @param {object} options
 * @param {number} [options.staleLockSec=900]
 * @param {number} [options.waitTimeoutSec=60]
 * @returns {Promise<{ lockPath: string, release: () => void }>}
 */
export async function acquireLock(repoPath, options = {}) {
  const staleLockSec = options.staleLockSec || 900;
  const waitTimeoutSec = options.waitTimeoutSec || 60;

  if (!fs.existsSync(LOCKS_DIR)) {
    fs.mkdirSync(LOCKS_DIR, { recursive: true });
  }

  const lockPath = path.join(LOCKS_DIR, getLockDirName(repoPath));
  const startTime = Date.now();

  while (true) {
    try {
      fs.mkdirSync(lockPath);
      // Successfully created lock directory
      const infoFile = path.join(lockPath, 'info.json');
      fs.writeFileSync(infoFile, JSON.stringify({
        pid: process.pid,
        time: Date.now(),
        repoPath
      }, null, 2), 'utf8');

      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          try {
            fs.rmSync(lockPath, { recursive: true, force: true });
          } catch {
            // Ignore error on cleanup
          }
        }
      };

      return { lockPath, release };
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }

      // Lock exists. Check if it is stale.
      try {
        const stats = fs.statSync(lockPath);
        const ageSec = (Date.now() - stats.mtimeMs) / 1000;
        if (ageSec >= staleLockSec) {
          // Stale lock detected, remove and retry
          try {
            fs.rmSync(lockPath, { recursive: true, force: true });
            continue;
          } catch {
            // Another process might have cleaned it
          }
        }
      } catch {
        // Lock might have been released just now
        continue;
      }

      const elapsedSec = (Date.now() - startTime) / 1000;
      if (elapsedSec >= waitTimeoutSec) {
        throw new Error(
          `Kilit alınamadı (zaman aşımı: ${waitTimeoutSec}s): ${repoPath}\nKilit konumu: ${lockPath}`
        );
      }

      // Wait 1 second before retrying
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}
