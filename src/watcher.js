import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { logger } from './logger.js';
import { CONFIG_FILE } from './paths.js';
import { readLastLine, parseReflogLine, classifyReflogEvent } from './reflog.js';
import { defaultBranch } from './gitops.js';
import { updateState } from './state.js';

/**
 * Watches the minimal set of reflog files implied by the config and forwards
 * classified events to the queue. Also watches the config file for live reload.
 */
export class ReflogWatcher {
  /**
   * @param {ReturnType<import('./config.js').resolveConfig>} config
   * @param {import('./queue.js').UpdateQueue} queue
   * @param {() => void} [onConfigChange]
   */
  constructor(config, queue, onConfigChange) {
    this.config = config;
    this.queue = queue;
    this.onConfigChange = onConfigChange || (() => {});
    this.watcher = null;
    this.configWatcher = null;
  }

  /**
   * Computes the exact reflog file paths to watch, per source repo.
   * @returns {{ files: string[], byFile: Map<string, object> }}
   */
  _plan() {
    const files = [];
    const byFile = new Map();

    for (const repo of this.config.repos) {
      const gitDir = path.join(repo.path, '.git');
      if (!fs.existsSync(gitDir)) {
        logger.warn(`[${repo.name}] git dizini yok, izlenmiyor: ${repo.path}`);
        continue;
      }

      const triggers = new Set();
      for (const pkg of repo.packages) for (const t of pkg.triggers) triggers.add(t);

      const branches =
        repo.branches.length > 0 ? repo.branches : [defaultBranch(repo.path)];

      const wantRemote = triggers.has('push') || triggers.has('fetch');
      const wantLocal = triggers.has('commit') || triggers.has('merge');

      for (const branch of branches) {
        if (wantRemote) {
          const remote = path.join(gitDir, 'logs', 'refs', 'remotes', 'origin', branch);
          files.push(remote);
          byFile.set(remote, repo);
        }
        if (wantLocal) {
          const local = path.join(gitDir, 'logs', 'refs', 'heads', branch);
          files.push(local);
          byFile.set(local, repo);
        }
      }
    }
    return { files, byFile };
  }

  start() {
    this.stop();
    const { files, byFile } = this._plan();
    this.byFile = byFile;

    logger.info(`Reflog izleyici: ${files.length} dosya`);
    files.forEach((f) => logger.debug(`  izleniyor: ${f}`));

    // Record current head shas as the baseline so history is not replayed.
    updateState((state) => {
      for (const [file, repo] of byFile) {
        const parsed = parseReflogLine(readLastLine(file) || '');
        if (parsed) {
          state.repos[repo.path] = {
            ...(state.repos[repo.path] || {}),
            lastProcessedSha: parsed.newSha,
            lastProcessedAt: Date.now()
          };
        }
      }
      return state;
    });

    this.watcher = chokidar.watch(files, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
    });
    const handler = (filePath) => this._onReflogChange(filePath);
    this.watcher.on('add', handler);
    this.watcher.on('change', handler);

    if (fs.existsSync(CONFIG_FILE)) {
      this.configWatcher = chokidar.watch(CONFIG_FILE, { ignoreInitial: true });
      this.configWatcher.on('change', () => {
        logger.info('Konfigürasyon değişti, yeniden yükleniyor...');
        this.onConfigChange();
      });
    }
  }

  /** @param {string} filePath */
  _onReflogChange(filePath) {
    const repo = this.byFile.get(filePath);
    if (!repo) return;

    const parsed = parseReflogLine(readLastLine(filePath) || '');
    if (!parsed) return;

    const event = classifyReflogEvent(filePath, parsed);
    if (!event) return;

    // Only feed triggers that at least one target actually wants.
    const wanted = repo.packages.some((p) => p.triggers.includes(event.trigger));
    if (!wanted) return;

    logger.info(
      `[${repo.name}] ${event.trigger} algılandı (branch: ${event.branch}, ` +
        `sha: ${event.sha.slice(0, 7)})`
    );
    this.queue.enqueue(repo, {
      trigger: event.trigger,
      branch: event.branch,
      sha: event.sha
    });
  }

  async stop() {
    await this.watcher?.close();
    await this.configWatcher?.close();
    this.watcher = null;
    this.configWatcher = null;
  }
}
