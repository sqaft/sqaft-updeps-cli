import { styleText } from 'node:util';
import { shellQuote } from './exec.js';

/**
 * Builds a reverse index: target repo path -> ordered list of source repos
 * (from config order) that declare that target as a dependent.
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 * @returns {Map<string, Array<{ name: string, path: string }>>}
 */
export function buildReverseIndex(config) {
  const index = new Map();
  for (const repo of config.repos) {
    for (const pkg of repo.packages) {
      if (!index.has(pkg.path)) index.set(pkg.path, []);
      const list = index.get(pkg.path);
      if (!list.some((s) => s.path === repo.path)) {
        list.push({ name: repo.name, path: repo.path });
      }
    }
  }
  return index;
}

/**
 * Returns the package-manager identifiers to pass to update commands for a
 * given target: the names of every source repo that lists this target as a
 * dependent, in config order.
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 * @param {string} targetPath
 * @returns {string[]}
 */
export function derivePackageNames(config, targetPath) {
  const index = buildReverseIndex(config);
  return (index.get(targetPath) || []).map((s) => s.name);
}

/**
 * Same as derivePackageNames but joined and shell-quoted, ready to substitute
 * into a `{pkgs}` placeholder.
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 * @param {string} targetPath
 * @returns {string}
 */
export function derivePkgsString(config, targetPath) {
  return derivePackageNames(config, targetPath).map(shellQuote).join(' ');
}

/**
 * Detects dependency cycles across the source→target edges.
 * A cycle here means "repo A depends on repo B which (transitively) depends on
 * A", which matters once `push: true` is enabled anywhere on the path.
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 * @returns {string[][]} list of cycles, each as an ordered list of repo names
 */
export function findCycles(config) {
  /** @type {Map<string, string[]>} path -> [target paths] */
  const adj = new Map();
  /** @type {Map<string, string>} path -> display name */
  const nameOf = new Map();

  for (const repo of config.repos) {
    nameOf.set(repo.path, repo.name);
    if (!adj.has(repo.path)) adj.set(repo.path, []);
    for (const pkg of repo.packages) {
      nameOf.set(pkg.path, nameOf.get(pkg.path) || pkg.name);
      adj.get(repo.path).push(pkg.path);
      if (!adj.has(pkg.path)) adj.set(pkg.path, []);
    }
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map([...adj.keys()].map((k) => [k, WHITE]));
  const stack = [];
  const cycles = [];
  const seen = new Set();

  function dfs(node) {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adj.get(node) || []) {
      if (color.get(next) === GRAY) {
        const start = stack.indexOf(next);
        const cyclePaths = stack.slice(start).concat(next);
        const key = [...cyclePaths].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cyclePaths.map((p) => nameOf.get(p) || p));
        }
      } else if (color.get(next) === WHITE) {
        dfs(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }

  for (const node of adj.keys()) {
    if (color.get(node) === WHITE) dfs(node);
  }
  return cycles;
}

/**
 * Renders an ASCII dependency tree of source repos and their targets.
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 * @returns {string}
 */
export function renderTree(config) {
  if (config.repos.length === 0) return '(config is empty — no source repos defined yet)';

  const lines = [];
  for (const repo of config.repos) {
    lines.push(`${repo.name}  ${dim(repo.rawPath)}`);
    const pkgs = repo.packages;
    pkgs.forEach((pkg, i) => {
      const isLast = i === pkgs.length - 1;
      const branch = isLast ? '└─' : '├─';
      const triggers = pkg.triggers.join(',');
      lines.push(`  ${branch} ${pkg.name}  ${dim(`[${triggers}]`)} ${dim(pkg.rawPath)}`);
    });
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function dim(s) {
  return styleText('dim', s);
}
