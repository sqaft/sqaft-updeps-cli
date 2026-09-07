import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, CONFIG_DIR, resolveHome } from './paths.js';

export const DEFAULT_CONFIG_VALUES = {
  triggers: ['push'],
  commands: ['npm update {pkgs} --no-audit --no-fund'],
  commitMessage: 'chore(deps): bump {bumps}',
  commandTimeout: 300,
  debounceMs: 3000,
  maxConcurrent: 3,
  globalMaxConcurrent: 3,
  staleLockSec: 900,
  waitTimeoutSec: 0,
  push: false
};

/**
 * Validates the raw parsed config object.
 * @param {unknown} raw
 * @throws {Error} with friendly message if invalid
 */
export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Konfigürasyon geçerli bir JSON objesi olmalıdır.');
  }

  if (raw.notifications !== undefined && typeof raw.notifications !== 'boolean') {
    throw new Error('"notifications" alanı boolean (true/false) olmalıdır.');
  }

  if (raw.defaults !== undefined) {
    if (typeof raw.defaults !== 'object' || Array.isArray(raw.defaults)) {
      throw new Error('"defaults" bir nesne olmalıdır.');
    }
    const d = raw.defaults;
    if (d.triggers !== undefined && (!Array.isArray(d.triggers) || d.triggers.some(t => typeof t !== 'string'))) {
      throw new Error('"defaults.triggers" bir string dizisi olmalıdır.');
    }
    if (d.commands !== undefined && (!Array.isArray(d.commands) || d.commands.some(c => typeof c !== 'string'))) {
      throw new Error('"defaults.commands" bir string dizisi olmalıdır.');
    }
    if (d.commitMessage !== undefined && typeof d.commitMessage !== 'string') {
      throw new Error('"defaults.commitMessage" bir metin (string) olmalıdır.');
    }
    if (d.commandTimeout !== undefined && (typeof d.commandTimeout !== 'number' || d.commandTimeout <= 0)) {
      throw new Error('"defaults.commandTimeout" pozitif bir sayı olmalıdır.');
    }
    if (d.debounceMs !== undefined && (typeof d.debounceMs !== 'number' || d.debounceMs < 0)) {
      throw new Error('"defaults.debounceMs" pozitif bir sayı olmalıdır.');
    }
    if (d.maxConcurrent !== undefined && (typeof d.maxConcurrent !== 'number' || d.maxConcurrent <= 0)) {
      throw new Error('"defaults.maxConcurrent" pozitif bir sayı olmalıdır.');
    }
    if (d.globalMaxConcurrent !== undefined && (typeof d.globalMaxConcurrent !== 'number' || d.globalMaxConcurrent <= 0)) {
      throw new Error('"defaults.globalMaxConcurrent" pozitif bir sayı olmalıdır.');
    }
    if (d.staleLockSec !== undefined && (typeof d.staleLockSec !== 'number' || d.staleLockSec <= 0)) {
      throw new Error('"defaults.staleLockSec" pozitif bir sayı olmalıdır.');
    }
    if (d.waitTimeoutSec !== undefined && (typeof d.waitTimeoutSec !== 'number' || d.waitTimeoutSec < 0)) {
      throw new Error('"defaults.waitTimeoutSec" 0 veya pozitif bir sayı olmalıdır.');
    }
    if (d.push !== undefined && typeof d.push !== 'boolean') {
      throw new Error('"defaults.push" boolean (true/false) olmalıdır.');
    }
  }

  if (raw.repos !== undefined) {
    if (!Array.isArray(raw.repos)) {
      throw new Error('"repos" bir dizi (array) olmalıdır.');
    }

    raw.repos.forEach((repo, rIndex) => {
      if (!repo || typeof repo !== 'object' || Array.isArray(repo)) {
        throw new Error(`repos[${rIndex}] geçerli bir nesne olmalıdır.`);
      }
      if (!repo.path || typeof repo.path !== 'string') {
        throw new Error(`repos[${rIndex}].path zorunludur ve bir metin olmalıdır.`);
      }
      if (repo.name !== undefined && typeof repo.name !== 'string') {
        throw new Error(`repos[${rIndex}].name bir metin olmalıdır.`);
      }

      if (repo.packages !== undefined) {
        if (!Array.isArray(repo.packages)) {
          throw new Error(`repos[${rIndex}].packages bir dizi olmalıdır.`);
        }

        repo.packages.forEach((pkg, pIndex) => {
          if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
            throw new Error(`repos[${rIndex}].packages[${pIndex}] bir nesne olmalıdır.`);
          }
          if (!pkg.path || typeof pkg.path !== 'string') {
            throw new Error(`repos[${rIndex}].packages[${pIndex}].path zorunludur ve bir metin olmalıdır.`);
          }
          if (pkg.name !== undefined && typeof pkg.name !== 'string') {
            throw new Error(`repos[${rIndex}].packages[${pIndex}].name bir metin olmalıdır.`);
          }
          if (pkg.triggers !== undefined && (!Array.isArray(pkg.triggers) || pkg.triggers.some(t => typeof t !== 'string'))) {
            throw new Error(`repos[${rIndex}].packages[${pIndex}].triggers bir string dizisi olmalıdır.`);
          }
          if (pkg.branches !== undefined && (!Array.isArray(pkg.branches) || pkg.branches.some(b => typeof b !== 'string'))) {
            throw new Error(`repos[${rIndex}].packages[${pIndex}].branches bir string dizisi olmalıdır.`);
          }
          if (pkg.commands !== undefined && (!Array.isArray(pkg.commands) || pkg.commands.some(c => typeof c !== 'string'))) {
            throw new Error(`repos[${rIndex}].packages[${pIndex}].commands bir string dizisi olmalıdır.`);
          }
          if (pkg.commitMessage !== undefined && typeof pkg.commitMessage !== 'string') {
            throw new Error(`repos[${rIndex}].packages[${pIndex}].commitMessage bir metin olmalıdır.`);
          }
          if (pkg.push !== undefined && typeof pkg.push !== 'boolean') {
            throw new Error(`repos[${rIndex}].packages[${pIndex}].push boolean olmalıdır.`);
          }
          if (pkg.commandTimeout !== undefined && (typeof pkg.commandTimeout !== 'number' || pkg.commandTimeout <= 0)) {
            throw new Error(`repos[${rIndex}].packages[${pIndex}].commandTimeout pozitif bir sayı olmalıdır.`);
          }
          if (pkg.staleLockSec !== undefined && (typeof pkg.staleLockSec !== 'number' || pkg.staleLockSec <= 0)) {
            throw new Error(`repos[${rIndex}].packages[${pIndex}].staleLockSec pozitif bir sayı olmalıdır.`);
          }
          if (pkg.waitTimeoutSec !== undefined && (typeof pkg.waitTimeoutSec !== 'number' || pkg.waitTimeoutSec < 0)) {
            throw new Error(`repos[${rIndex}].packages[${pIndex}].waitTimeoutSec 0 veya pozitif bir sayı olmalıdır.`);
          }
        });
      }
    });
  }
}

/**
 * Resolves full config with defaults inheritance and path expansion.
 * @param {object} raw
 * @returns {object}
 */
export function resolveConfig(raw) {
  validateConfig(raw);

  const defaults = {
    ...DEFAULT_CONFIG_VALUES,
    ...(raw.defaults || {})
  };

  const notifications = raw.notifications !== undefined ? Boolean(raw.notifications) : true;

  const repos = (raw.repos || []).map(repo => {
    const resolvedRepoPath = resolveHome(repo.path);
    const repoName = repo.name || path.basename(resolvedRepoPath);

    const packages = (repo.packages || []).map(pkg => {
      const resolvedPkgPath = resolveHome(pkg.path);
      const pkgName = pkg.name || path.basename(resolvedPkgPath);

      return {
        path: resolvedPkgPath,
        rawPath: pkg.path,
        name: pkgName,
        triggers: pkg.triggers ? [...pkg.triggers] : [...defaults.triggers],
        branches: pkg.branches ? [...pkg.branches] : [],
        commands: pkg.commands ? [...pkg.commands] : [...defaults.commands],
        commitMessage: pkg.commitMessage !== undefined ? pkg.commitMessage : defaults.commitMessage,
        push: pkg.push !== undefined ? Boolean(pkg.push) : Boolean(defaults.push),
        commandTimeout: pkg.commandTimeout !== undefined ? pkg.commandTimeout : defaults.commandTimeout,
        staleLockSec: pkg.staleLockSec !== undefined ? pkg.staleLockSec : defaults.staleLockSec,
        waitTimeoutSec: pkg.waitTimeoutSec !== undefined ? pkg.waitTimeoutSec : defaults.waitTimeoutSec
      };
    });

    return {
      path: resolvedRepoPath,
      rawPath: repo.path,
      name: repoName,
      packages
    };
  });

  return {
    notifications,
    defaults,
    repos
  };
}

/**
 * Loads and resolves the configuration file.
 * @param {string} [filePath=CONFIG_FILE]
 * @returns {object}
 */
export function loadConfig(filePath = CONFIG_FILE) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Konfigürasyon dosyası bulunamadı: ${filePath}\n"updeps init" komutu ile örnek bir konfigürasyon oluşturabilirsiniz.`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Konfigürasyon dosyası JSON formatında değil: ${filePath}\nHata: ${err.message}`);
  }

  return resolveConfig(parsed);
}

/**
 * Writes config object to file atomically.
 * @param {object} config
 * @param {string} [filePath=CONFIG_FILE]
 */
export function saveConfig(config, filePath = CONFIG_FILE) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tempFile = `${filePath}.tmp.${Date.now()}`;
  fs.writeFileSync(tempFile, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tempFile, filePath);
}

/**
 * Returns a starter configuration object.
 */
export function createDefaultConfig() {
  return {
    repos: [
      {
        path: '~/workspace/http',
        packages: [
          {
            path: '~/workspace/client',
            triggers: ['push', 'fetch'],
            branches: ['main', 'develop'],
            commands: [
              'npm update {pkgs} --no-audit --no-fund',
              'npm run build'
            ]
          }
        ]
      }
    ],
    defaults: {
      triggers: ['push'],
      commands: ['npm update {pkgs} --no-audit --no-fund'],
      commitMessage: 'chore(deps): bump {bumps}',
      commandTimeout: 300,
      debounceMs: 3000,
      maxConcurrent: 3,
      globalMaxConcurrent: 3,
      staleLockSec: 900,
      waitTimeoutSec: 0,
      push: false
    },
    notifications: true
  };
}
