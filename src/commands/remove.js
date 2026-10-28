import fs from 'node:fs';
import { styleText } from 'node:util';
import { CONFIG_FILE } from '../paths.js';
import { validateConfig } from '../config.js';

/**
 * Removes a target from a source, or the whole source if no target is given.
 * Matches by path or by name.
 * @param {string[]} positionals  [sourceSelector, targetSelector?]
 */
export function cmdRemove(positionals) {
  const [sourceSel, targetSel] = positionals;
  if (!sourceSel) {
    console.error('Usage: updeps remove <source> [target]');
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  raw.repos ||= [];

  const repoIdx = raw.repos.findIndex((r) => r.path === sourceSel || r.name === sourceSel);
  if (repoIdx === -1) {
    console.error(styleText('red', `Source not found: ${sourceSel}`));
    process.exit(1);
  }

  if (!targetSel) {
    const [removed] = raw.repos.splice(repoIdx, 1);
    console.log(styleText('green', `Source removed: ${removed.name || removed.path}`));
  } else {
    const repo = raw.repos[repoIdx];
    const before = (repo.packages || []).length;
    repo.packages = (repo.packages || []).filter(
      (p) => p.path !== targetSel && p.name !== targetSel
    );
    if (repo.packages.length === before) {
      console.error(styleText('red', `Target not found: ${targetSel}`));
      process.exit(1);
    }
    console.log(styleText('green', `Target removed: ${targetSel}`));
  }

  validateConfig(raw);
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
}
