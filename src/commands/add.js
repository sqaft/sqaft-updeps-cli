import fs from 'node:fs';
import path from 'node:path';
import { styleText } from 'node:util';
import { CONFIG_FILE } from '../paths.js';
import { validateConfig } from '../config.js';

/**
 * Adds a source→target relationship to the raw config file (comments/formatting
 * aside, this rewrites the JSON).
 * @param {string[]} positionals  [sourcePath]
 * @param {{ target?: string, name?: string, 'target-name'?: string, command?: string|string[] }} opts
 */
export function cmdAdd(positionals, opts = {}) {
  const sourcePath = positionals[0];
  if (!sourcePath || !opts.target) {
    console.error('Usage: updeps add <source-path> --target <target-path> [--name <package-name>] [--target-name <name>] [--command "<command>"]');
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  raw.repos ||= [];

  let repo = raw.repos.find((r) => r.path === sourcePath);
  if (!repo) {
    repo = { path: sourcePath, name: opts.name || path.basename(sourcePath), packages: [] };
    raw.repos.push(repo);
  } else if (opts.name) {
    repo.name = opts.name;
  }
  repo.packages ||= [];

  if (repo.packages.some((p) => p.path === opts.target)) {
    console.error(styleText('yellow', 'This target is already registered.'));
    process.exit(1);
  }

  const pkg = { path: opts.target, name: opts['target-name'] || path.basename(opts.target) };
  if (opts.command) {
    pkg.commands = Array.isArray(opts.command) ? opts.command : [opts.command];
  }
  repo.packages.push(pkg);

  validateConfig(raw);
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);

  console.log(styleText('green', `Added: ${repo.name} → ${pkg.name}`));
}
