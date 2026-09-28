import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { logger } from './logger.js';
import { CONFIG_FILE, CONFIG_DIR } from './paths.js';
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
    this.configReloadTimer = null;
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

    this._catchUpMissedEvents(files);

    this.watcher = chokidar.watch(files, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
    });
    const handler = (filePath) => this._onReflogChange(filePath);
    this.watcher.on('add', handler);
    this.watcher.on('change', handler);

    this._watchConfig();
  }

  /**
   * Catches up on reflog changes that happened while nothing was watching
   * (daemon down for a restart/crash, or the gap before `updeps start`).
   * Without this, `start()` used to just record the current tip as a fresh
   * baseline — a push made during that gap left no trace, since chokidar
   * only reports changes from here on (`ignoreInitial: true`).
   *
   * Compares each watched file's current tip against the tip recorded the
   * last time *this exact file* was watched (`state.reflogTips`, keyed by
   * path so different branches of the same repo never share a baseline). A
   * mismatch is fed through the normal event pipeline exactly like a live
   * chokidar 'change'. A file seen for the first time ever (fresh install,
   * or after `updeps reset`) just records its baseline — there's nothing to
   * "catch up" on since no prior state exists to compare against.
   * @param {string[]} files
   */
  _catchUpMissedEvents(files) {
    const missed = [];
    updateState((state) => {
      state.reflogTips = state.reflogTips || {};
      for (const file of files) {
        const parsed = parseReflogLine(readLastLine(file) || '');
        if (!parsed) continue;
        const storedTip = state.reflogTips[file];
        state.reflogTips[file] = parsed.newSha;
        if (storedTip !== undefined && storedTip !== parsed.newSha) missed.push(file);
      }
      return state;
    });

    for (const file of missed) {
      logger.info(`[${this.byFile.get(file)?.name}] kaçırılan olay yakalandı, işleniyor: ${file}`);
      this._onReflogChange(file);
    }
  }

  /**
   * Watches the config file for live reload. We watch the *containing directory*
   * rather than the file itself: `updeps init`, `add`/`remove` and most editors
   * replace the file via an atomic rename (write temp + `rename()`), which swaps
   * the inode and makes a single-file watch go permanently silent after the
   * first change. Directory watching survives that; we filter down to the exact
   * path and debounce so a rename (unlink + add) reloads only once.
   */
  _watchConfig() {
    if (!fs.existsSync(CONFIG_DIR)) return;

    this.configWatcher = chokidar.watch(CONFIG_DIR, {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
    });

    const onChange = (filePath) => {
      if (path.resolve(filePath) !== CONFIG_FILE) return;
      if (this.configReloadTimer) clearTimeout(this.configReloadTimer);
      this.configReloadTimer = setTimeout(() => {
        this.configReloadTimer = null;
        logger.info('Konfigürasyon değişti, yeniden yükleniyor...');
        this.onConfigChange();
      }, 100);
    };

    this.configWatcher.on('add', onChange);
    this.configWatcher.on('change', onChange);
  }

  /** @param {string} filePath */
  _onReflogChange(filePath) {
    const repo = this.byFile.get(filePath);
    if (!repo) return;

    const parsed = parseReflogLine(readLastLine(filePath) || '');
    if (!parsed) return;

    // Keep the catch-up baseline current so a restart never re-processes a
    // push that was already handled live.
    updateState((state) => {
      state.reflogTips = state.reflogTips || {};
      state.reflogTips[filePath] = parsed.newSha;
      return state;
    });

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
    if (this.configReloadTimer) {
      clearTimeout(this.configReloadTimer);
      this.configReloadTimer = null;
    }
    // Detach the handles synchronously. `start()` calls `stop()` without
    // awaiting and then immediately assigns fresh watchers; if we nulled these
    // *after* the awaited close() the continuation would clobber the new ones.
    const watcher = this.watcher;
    const configWatcher = this.configWatcher;
    this.watcher = null;
    this.configWatcher = null;
    await watcher?.close();
    await configWatcher?.close();
  }
}
