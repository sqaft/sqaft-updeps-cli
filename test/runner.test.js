import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { runTarget, checkGitPreconditions, rollbackWorkingTree } from '../src/runner.js';

import { updateState } from '../src/state.js';

describe('Runner Pipeline', () => {
  const testDir = path.join(os.tmpdir(), `sqaft-runner-test-${Date.now()}`);
  const targetDir = path.join(testDir, 'target-client');
  const sourceRepo = {
    name: 'http-pkg',
    path: path.join(testDir, 'source-http')
  };

  before(() => {
    fs.mkdirSync(targetDir, { recursive: true });
    execSync('git init -b main', { cwd: targetDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: targetDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: targetDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({ name: 'target-client', version: '1.0.0' }));
    execSync('git add . && git commit -m "initial commit"', { cwd: targetDir, stdio: 'ignore' });
  });

  after(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
    updateState(s => {
      s.errors = (s.errors || []).filter(e => !e.id.includes('target-client'));
      return s;
    });
  });

  it('verifies preconditions for clean git repo', () => {
    const pre = checkGitPreconditions(targetDir);
    assert.equal(pre.ok, true);
  });

  it('fails preconditions if working tree is dirty', () => {
    fs.writeFileSync(path.join(targetDir, 'dirty.txt'), 'dirty content');
    const pre = checkGitPreconditions(targetDir);
    assert.equal(pre.ok, false);
    assert.ok(pre.reason.includes('Working tree temiz değil'));

    // Clean up
    rollbackWorkingTree(targetDir);
    const pre2 = checkGitPreconditions(targetDir);
    assert.equal(pre2.ok, true);
  });

  it('executes commands, commits changes with commitMessage, does not push when push is false', async () => {
    const pkg = {
      path: targetDir,
      name: 'target-client',
      triggers: ['push'],
      commands: [
        `node -e "require('fs').writeFileSync('bumped.txt', 'updated')"`
      ],
      commitMessage: 'chore(deps): bump {bumps}',
      push: false,
      commandTimeout: 30
    };

    const triggerContext = {
      trigger: 'push',
      sha: 'abcdef1234567890',
      branch: 'main'
    };

    const res = await runTarget({
      sourceRepo,
      pkg,
      triggerContext,
      dryRun: false,
      echo: false
    });

    assert.equal(res.status, 'committed');
    assert.equal(res.message, 'chore(deps): bump http-pkg@abcdef1');

    // Check last commit message in target repo
    const lastCommitMsg = execSync('git log -1 --pretty=%B', { cwd: targetDir, encoding: 'utf8' }).trim();
    assert.equal(lastCommitMsg, 'chore(deps): bump http-pkg@abcdef1');

    // Working tree should be clean
    const status = execSync('git status --porcelain', { cwd: targetDir, encoding: 'utf8' }).trim();
    assert.equal(status, '');
  });

  it('reverts working tree if a command fails', async () => {
    const pkg = {
      path: targetDir,
      name: 'target-client',
      triggers: ['push'],
      commands: [
        `node -e "require('fs').writeFileSync('broken.txt', 'dirty'); process.exit(1);"`
      ],
      commitMessage: 'chore: fail',
      push: false,
      commandTimeout: 30
    };

    const res = await runTarget({
      sourceRepo,
      pkg,
      triggerContext: { trigger: 'push', sha: '999999', branch: 'main' },
      dryRun: false,
      echo: false
    });

    assert.equal(res.status, 'failed');

    // Broken file should have been rolled back
    assert.ok(!fs.existsSync(path.join(targetDir, 'broken.txt')));
  });
});
