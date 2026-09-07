import path from 'node:path';

/**
 * Builds an adjacency list representation of the configured repos and packages.
 * @param {object} config Resolved config object
 * @returns {Map<string, { repo: object, targets: object[] }>}
 */
export function buildGraph(config) {
  const graph = new Map();

  for (const repo of config.repos) {
    const key = repo.path;
    graph.set(key, {
      repo,
      targets: repo.packages || []
    });
  }

  return graph;
}

/**
 * Detects cycles in the configured dependency graph.
 * @param {object} config Resolved config
 * @returns {Array<string[]>} List of cycle paths
 */
export function detectCycles(config) {
  const cycles = [];
  const visited = new Set();
  const recStack = new Set();

  /**
   * @param {string} currentPath
   * @param {string[]} pathTrail
   */
  function dfs(currentPath, pathTrail) {
    visited.add(currentPath);
    recStack.add(currentPath);

    const repo = config.repos.find(r => r.path === currentPath);
    if (repo && repo.packages) {
      for (const target of repo.packages) {
        if (!visited.has(target.path)) {
          dfs(target.path, [...pathTrail, target.path]);
        } else if (recStack.has(target.path)) {
          cycles.push([...pathTrail, target.path]);
        }
      }
    }

    recStack.delete(currentPath);
  }

  for (const repo of config.repos) {
    if (!visited.has(repo.path)) {
      dfs(repo.path, [repo.path]);
    }
  }

  return cycles;
}

/**
 * Formats an ASCII tree representation of the repos and dependent packages.
 * @param {object} config Resolved config
 * @returns {string}
 */
export function formatAsciiGraph(config) {
  if (!config.repos || config.repos.length === 0) {
    return 'Tanımlı herhangi bir repo bulunamadı.';
  }

  const lines = [];
  const cycles = detectCycles(config);

  if (cycles.length > 0) {
    lines.push('⚠️  UYARI: Döngüsel bağımlılık (cycle) tespit edildi:');
    for (const c of cycles) {
      lines.push(`   ${c.map(p => path.basename(p)).join(' -> ')}`);
    }
    lines.push('');
  }

  lines.push('Bağımlılık Ağacı:');

  for (let i = 0; i < config.repos.length; i++) {
    const repo = config.repos[i];
    const isLastRepo = i === config.repos.length - 1;
    const repoPrefix = isLastRepo ? '└── ' : '├── ';

    lines.push(`${repoPrefix}${repo.name} (${repo.rawPath || repo.path})`);

    const packages = repo.packages || [];
    const childIndent = isLastRepo ? '    ' : '│   ';

    if (packages.length === 0) {
      lines.push(`${childIndent}└── (hedef bağımlılık tanımlanmamış)`);
    } else {
      for (let j = 0; j < packages.length; j++) {
        const pkg = packages[j];
        const isLastPkg = j === packages.length - 1;
        const pkgPrefix = isLastPkg ? '└── ' : '├── ';
        const triggers = pkg.triggers.join(', ');
        const pushText = pkg.push ? ' [push: aktif]' : '';

        lines.push(
          `${childIndent}${pkgPrefix}► ${pkg.name} (${pkg.rawPath || pkg.path})` +
          ` [${triggers}]${pushText}`
        );

        const subIndent = childIndent + (isLastPkg ? '    ' : '│   ');
        for (const cmd of pkg.commands) {
          lines.push(`${subIndent}  $ ${cmd}`);
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Finds all packages dependent on a given source repo path or name.
 * @param {object} config Resolved config
 * @param {string} sourcePathOrName
 * @returns {object|null}
 */
export function findRepo(config, sourcePathOrName) {
  return config.repos.find(r =>
    r.path === sourcePathOrName ||
    r.name === sourcePathOrName ||
    r.rawPath === sourcePathOrName ||
    path.resolve(sourcePathOrName) === r.path
  ) || null;
}
