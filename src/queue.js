import { loadState } from './state.js';
import { logger } from './logger.js';
import { runSourceRepo } from './runner.js';

export class UpdateQueue {
  /**
   * @param {object} config
   */
  constructor(config) {
    this.config = config;
    this.timers = new Map();
    this.pendingEvents = new Map();
    this.runningRepos = new Set();
    this.readyQueue = [];
  }

  /**
   * Updates configuration dynamically (e.g. when config file changes).
   * @param {object} newConfig
   */
  updateConfig(newConfig) {
    this.config = newConfig;
    this.drain();
  }

  /**
   * Enqueues an update event for a source repo.
   * Debounces execution by debounceMs.
   * @param {object} sourceRepo
   * @param {object} eventContext
   */
  enqueue(sourceRepo, eventContext) {
    const repoPath = sourceRepo.path;
    const debounceMs = this.config.defaults?.debounceMs ?? 3000;

    // Check duplicate SHA
    if (eventContext.sha) {
      const state = loadState();
      const repoState = state.repos[repoPath];
      if (repoState && repoState.lastProcessedSha === eventContext.sha) {
        logger.debug(`[${sourceRepo.name}] SHA (${eventContext.sha.slice(0, 7)}) zaten işlendi, atlanıyor.`);
        return;
      }
    }

    // Save latest event context
    this.pendingEvents.set(repoPath, { sourceRepo, eventContext });

    // Clear existing timer if any
    if (this.timers.has(repoPath)) {
      clearTimeout(this.timers.get(repoPath));
    }

    logger.info(`[${sourceRepo.name}] Olay algılandı (${eventContext.trigger}, sha: ${(eventContext.sha || '').slice(0, 7)}). ${debounceMs}ms debounce bekleniyor...`);

    const timer = setTimeout(() => {
      this.timers.delete(repoPath);
      if (!this.readyQueue.includes(repoPath)) {
        this.readyQueue.push(repoPath);
      }
      this.drain();
    }, debounceMs);

    this.timers.set(repoPath, timer);
  }

  /**
   * Drains the ready queue respecting globalMaxConcurrent limit (0 = unlimited).
   */
  drain() {
    const globalMaxConcurrent = this.config.defaults?.globalMaxConcurrent ?? 0;

    while (this.readyQueue.length > 0) {
      if (globalMaxConcurrent > 0 && this.runningRepos.size >= globalMaxConcurrent) {
        break;
      }

      // Find the first repo in readyQueue that is not currently running
      const nextIndex = this.readyQueue.findIndex(r => !this.runningRepos.has(r));
      if (nextIndex === -1) {
        // All ready repos are currently running, wait for one to finish
        break;
      }

      const [repoPath] = this.readyQueue.splice(nextIndex, 1);
      this.process(repoPath);
    }
  }

  /**
   * Processes the pending event for a repo.
   * @param {string} repoPath
   */
  async process(repoPath) {
    const item = this.pendingEvents.get(repoPath);
    if (!item) return;
    this.pendingEvents.delete(repoPath);

    this.runningRepos.add(repoPath);
    try {
      await runSourceRepo({
        config: this.config,
        sourceRepo: item.sourceRepo,
        triggerContext: item.eventContext,
        dryRun: false,
        echo: false
      });
    } catch (err) {
      logger.error(`[${item.sourceRepo.name}] Çalıştırma hatası: ${err.message}`);
    } finally {
      this.runningRepos.delete(repoPath);

      // If new event arrived while running, requeue it
      if (this.pendingEvents.has(repoPath) && !this.readyQueue.includes(repoPath)) {
        this.readyQueue.push(repoPath);
      }

      this.drain();
    }
  }
}
