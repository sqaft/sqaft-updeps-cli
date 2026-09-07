import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { interpolateVariables } from '../src/runner.js';

describe('interpolateVariables', () => {
  it('interpolates {pkg}, {sha}, {bumps}, {branch}', () => {
    const vars = {
      pkg: 'http',
      pkgs: 'http',
      sha: '1234567890abcdef',
      sourcePath: '/workspace/http',
      targetPath: '/workspace/client',
      sourceBranch: 'main',
      targetBranch: 'main'
    };

    const cmd = interpolateVariables('npm update {pkgs} --no-audit && echo {sha}', vars);
    assert.equal(cmd, 'npm update http --no-audit && echo 1234567');

    const msg = interpolateVariables('chore(deps): bump {bumps}', vars);
    assert.equal(msg, 'chore(deps): bump http@1234567');
  });

  it('handles custom bumps or missing vars safely', () => {
    const vars = {
      pkg: 'core',
      sha: ''
    };
    const msg = interpolateVariables('bump {bumps}', vars);
    assert.equal(msg, 'bump core@');
  });
});
