import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UpdateQueue } from '../src/queue.js';

describe('UpdateQueue Concurrency & Drain', () => {
  it('respects globalMaxConcurrent limit across different repos', async () => {
    const config = {
      defaults: {
        debounceMs: 50,
        globalMaxConcurrent: 2
      },
      repos: []
    };

    const queue = new UpdateQueue(config);

    let activeCount = 0;
    let maxActiveSeen = 0;
    const completed = [];

    // Monkey-patch queue.process to simulate async execution
    queue.process = async function (repoPath) {
      this.runningRepos.add(repoPath);
      activeCount++;
      if (activeCount > maxActiveSeen) {
        maxActiveSeen = activeCount;
      }

      // Simulate async task taking 80ms
      await new Promise(r => setTimeout(r, 80));

      activeCount--;
      completed.push(repoPath);
      this.runningRepos.delete(repoPath);
      this.drain();
    };

    // Enqueue 5 repos at once
    for (let i = 1; i <= 5; i++) {
      queue.enqueue({ name: `repo-${i}`, path: `/tmp/repo-${i}` }, { trigger: 'push', sha: `sha-${i}` });
    }

    // Wait until all are completed
    await new Promise(r => {
      const check = setInterval(() => {
        if (completed.length === 5) {
          clearInterval(check);
          r();
        }
      }, 20);
    });

    assert.equal(completed.length, 5);
    // At no point should more than globalMaxConcurrent (2) be active simultaneously
    assert.ok(maxActiveSeen <= 2, `maxActiveSeen (${maxActiveSeen}) exceeded globalMaxConcurrent (2)`);
    assert.equal(maxActiveSeen, 2);
  });
});
