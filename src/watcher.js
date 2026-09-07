import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { parseReflogLine, classifyReflogEvent } from './classifier.js';
import { logger } from './logger.js';
import { CONFIG_FILE } from './paths.js';

/**
 * Reads the last non-empty line of a file efficiently.
 * @param {string} filePath
 * @returns {string|null}
 */
export function readLastLine(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return null;

    // Read last 4KB chunk
    const chunkSize = Math.min(4096, stat.size);
    const buffer = Buffer.alloc(chunkSize);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, chunkSize, stat.size - chunkSize);
    fs.closeSync(fd);

    const content = buffer.toString('utf8');
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    return lines.length > 0 ? lines[lines.length - 1] : null;
  } catch {
    return null;
  }
}

export class ReflogWatcher {
  /**
   * @param {object} config
   * @param {import('./queue.js').UpdateQueue} queue
   * @param {() => void} [onConfigReload]
   */
  constructor(config, queue, onConfigReload) {
    this.config = config;
    this.queue = queue;
    this.onConfigReload = onConfigReload;
    this.watcher = null;
    this.configWatcher = null;
  }

  /**
   * Derives reflog paths to watch based on registered repos and triggers.
   * @returns {string[]}
   */
  getWatchPaths() {
    const paths = [];

    for (const repo of this.config.repos) {
      const gitDir = path.join(repo.path, '.git');
      if (!fs.existsSync(gitDir)) continue;

      const logsDir = path.join(gitDir, 'logs', 'refs');
      if (!fs.existsSync(logsDir)) continue;

      // Collect all triggers for packages under this repo
      const allTriggers = new Set();
      for (const pkg of (repo.packages || [])) {
        for (const t of (pkg.triggers || [])) {
          allTriggers.add(t);
        }
      }

      // If remote triggers present (push, fetch)
      if (allTriggers.has('push') || allTriggers.has('fetch') || allTriggers.size === 0) {
        const remotesDir = path.join(logsDir, 'remotes');
        if (fs.existsSync(remotesDir)) {
          paths.push(remotesDir);
        }
      }

      // If local triggers present (commit, merge)
      if (allTriggers.has('commit') || allTriggers.has('merge')) {
        const headsDir = path.join(logsDir, 'heads');
        if (fs.existsSync(headsDir)) {
          paths.push(headsDir);
        }
      }
    }

    return paths;
  }

  /**
   * Starts watching reflogs and config file.
   */
  start() {
    this.stop();

    const watchPaths = this.getWatchPaths();
    logger.info(`Reflog izleyici başlatılıyor (${watchPaths.length} reflog dizini)...`);

    if (watchPaths.length > 0) {
      this.watcher = chokidar.watch(watchPaths, {
        ignoreInitial: true,
        usePolling: false,
        depth: 4,
        awaitWriteFinish: {
          stabilityThreshold: 300,
          pollInterval: 100
        }
      });

      this.watcher.on('change', (filePath) => this.handleFileEvent(filePath));
      this.watcher.on('add', (filePath) => this.handleFileEvent(filePath));
    }

    // Watch config file for live reload
    if (fs.existsSync(CONFIG_FILE)) {
      this.configWatcher = chokidar.watch(CONFIG_FILE, {
        ignoreInitial: true,
        usePolling: false
      });

      this.configWatcher.on('change', () => {
        logger.info('Konfigürasyon dosyası güncellendi, yeniden yükleniyor...');
        if (this.onConfigReload) {
          this.onConfigReload();
        }
      });
    }
  }

  /**
   * Handles a reflog file change.
   * @param {string} filePath
   */
  handleFileEvent(filePath) {
    // Find which repo this file belongs to
    const repo = this.config.repos.find(r => filePath.startsWith(r.path));
    if (!repo) return;

    const lastLine = readLastLine(filePath);
    if (!lastLine) return;

    const parsed = parseReflogLine(lastLine);
    if (!parsed) return;

    const event = classifyReflogEvent(filePath, parsed);
    if (!event) return;

    logger.debug(`[${repo.name}] Reflog olayı: ${event.trigger} (branch: ${event.branch}, sha: ${event.sha.slice(0, 7)})`);
    this.queue.enqueue(repo, event);
  }

  /**
   * Stops watchers.
   */
  async stop() {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.configWatcher) {
      await this.configWatcher.close();
      this.configWatcher = null;
    }
  }
}
