import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';
import { CONFIG_FILE, tildify } from '../paths.js';
import { validateConfig } from '../config.js';

const EXAMPLE_PATH = fileURLToPath(new URL('../../examples/config.json', import.meta.url));

const STARTER = {
  notifications: true,
  defaults: {
    triggers: ['push'],
    commands: ['npm update {pkgs} --no-audit --no-fund'],
    commitMessage: 'chore(deps): bump {bumps}',
    commandTimeout: 300,
    debounceMs: 3000,
    staleLockSec: 900,
    push: false
  },
  repos: [
    {
      path: '~/workspace/my-lib',
      name: 'my-lib',
      packages: [
        {
          path: '~/workspace/my-app',
          name: 'my-app'
        }
      ]
    }
  ]
};

/**
 * @param {{ force?: boolean, example?: boolean }} opts
 */
export function cmdInit(opts = {}) {
  if (fs.existsSync(CONFIG_FILE) && !opts.force) {
    console.error(
      styleText('yellow', `Already exists: ${tildify(CONFIG_FILE)}\n`) +
        'To overwrite: updeps init --force'
    );
    process.exit(1);
  }

  const content = opts.example ? fs.readFileSync(EXAMPLE_PATH, 'utf8') : JSON.stringify(STARTER, null, 2) + '\n';

  // sanity check whatever we're about to write
  validateConfig(JSON.parse(content));

  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, content, 'utf8');

  console.log(styleText('green', `Created: ${tildify(CONFIG_FILE)}`));
  console.log('After editing, verify with: updeps doctor');
}
