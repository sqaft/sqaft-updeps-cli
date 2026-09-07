import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Creates a throwaway directory, returns its path and a cleanup fn.
 * @returns {{ dir: string, cleanup: () => void }}
 */
export function tmpDir(prefix = 'updeps-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Initializes a git repo at dir with one commit. Returns dir.
 * @param {string} dir
 */
export function initGitRepo(dir) {
  const run = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  fs.mkdirSync(dir, { recursive: true });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  run(['add', '-A']);
  run(['commit', '-qm', 'init']);
  return { dir, git: run };
}
