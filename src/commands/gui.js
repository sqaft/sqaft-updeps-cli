import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';
import { DESKTOP_APP_DIR, tildify } from '../paths.js';
import { BIN_PATH } from '../launcher.js';

/** The desktop app's npm package. */
export const APP_PACKAGE = '@sqaft/updeps-app';

/** This CLI's package directory; the app is told to work with it. */
const CLI_ROOT = path.dirname(path.dirname(BIN_PATH));

/**
 * The desktop app this CLI opens: the checkout in `UPDEPS_APP` when set (for
 * development), otherwise the one `updeps gui install` put in DESKTOP_APP_DIR.
 * @returns {{ root: string, version: string, bin: string } | null} null when it is not installed
 */
export function findApp() {
  const root = process.env.UPDEPS_APP || path.join(DESKTOP_APP_DIR, 'node_modules', ...APP_PACKAGE.split('/'));
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['updeps-app'];
  if (pkg.name !== APP_PACKAGE || typeof rel !== 'string') return null;
  const bin = path.join(root, rel);
  return fs.existsSync(bin) ? { root, version: pkg.version, bin } : null;
}

/**
 * Installs the latest app (or updates it) into DESKTOP_APP_DIR with npm. The
 * directory is an npm project of its own, so nothing is installed globally
 * and no administrator rights are needed.
 * @returns {{ root: string, version: string, bin: string }}
 */
export function installApp() {
  fs.mkdirSync(DESKTOP_APP_DIR, { recursive: true });
  const manifest = path.join(DESKTOP_APP_DIR, 'package.json');
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(
      manifest,
      JSON.stringify({ private: true, description: 'The updeps desktop app, installed by "updeps gui install".' }, null, 2) + '\n'
    );
  }
  // npm is a .cmd script on Windows, which Node only runs through a shell.
  const res = spawnSync('npm', ['install', '--prefix', DESKTOP_APP_DIR, `${APP_PACKAGE}@latest`, '--no-audit', '--no-fund'], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (res.error) throw new Error(`Could not run npm: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`npm install ${APP_PACKAGE} failed (exit code ${res.status}).`);
  const app = findApp();
  if (!app) throw new Error(`npm finished, but ${APP_PACKAGE} is not in ${tildify(DESKTOP_APP_DIR)}.`);
  downloadElectron(app);
  return app;
}

/**
 * Electron downloads its binary the first time it is required, not when npm
 * installs it. Requiring it here makes that download part of the install, so
 * the first `updeps gui` opens right away and a failed download shows up now.
 * @param {{ root: string }} app
 */
function downloadElectron(app) {
  let entry;
  try {
    entry = createRequire(path.join(app.root, 'package.json')).resolve('electron');
  } catch {
    return; // an app version without Electron as a dependency
  }
  const res = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(entry)})`], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error('Downloading Electron failed. Run "updeps gui install" again.');
}

/**
 * Starts the app (it keeps running in the system tray) and returns. The app
 * is told which CLI install to work with, so it uses this one.
 * @param {{ root: string, bin: string }} app
 */
export function openApp(app) {
  const res = spawnSync(process.execPath, [app.bin], {
    stdio: 'inherit',
    env: { ...process.env, UPDEPS_CLI: CLI_ROOT }
  });
  if (res.error || res.status !== 0) {
    throw new Error(`The desktop app did not start: ${res.error?.message || `exit code ${res.status}`}`);
  }
}

/** @param {string} question @returns {Promise<boolean>} yes unless the answer starts with n */
async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return !/^n/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

const INSTALL_NOTE = 'It is installed with npm and downloads Electron (about 100 MB, 350 MB on disk).';

/**
 * `updeps gui` opens the desktop app, offering to install it first;
 * `updeps gui install` installs or updates it; `updeps gui uninstall` removes it.
 * @param {string[]} positionals
 */
export async function cmdGui(positionals) {
  const [action, ...extra] = positionals;
  if (extra.length || (action && !['install', 'uninstall'].includes(action))) {
    console.error('Usage: updeps gui [install | uninstall]');
    process.exit(1);
  }

  try {
    if (action === 'install') {
      const before = findApp();
      console.log(styleText('dim', `${before ? 'Updating' : 'Installing'} ${APP_PACKAGE} in ${tildify(DESKTOP_APP_DIR)}. ${INSTALL_NOTE}`));
      const app = installApp();
      console.log(styleText('green', `Desktop app ${app.version} installed.`) + ' Open it with: updeps gui');
      return;
    }

    if (action === 'uninstall') {
      if (!fs.existsSync(DESKTOP_APP_DIR)) {
        console.log('The desktop app is not installed.');
        return;
      }
      try {
        fs.rmSync(DESKTOP_APP_DIR, { recursive: true, force: true });
      } catch (err) {
        throw new Error(`Could not remove ${tildify(DESKTOP_APP_DIR)} (${err.code || err.message}). Quit the app and try again.`);
      }
      console.log(
        styleText('green', 'Desktop app removed.') +
          styleText('dim', ' If "Start at login" was on, turn it off before uninstalling next time, or remove its login entry.')
      );
      return;
    }

    let app = findApp();
    if (!app) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(styleText('red', 'The desktop app is not installed.') + ' Install it with: updeps gui install');
        process.exit(1);
      }
      console.log(`The desktop app is not installed. ${INSTALL_NOTE}`);
      if (!(await confirm('Install it now? [Y/n] '))) {
        console.log('Not installed. Install it later with: updeps gui install');
        return;
      }
      app = installApp();
      console.log(styleText('green', `Desktop app ${app.version} installed.`));
    }
    openApp(app);
    console.log(`Desktop app ${app.version} opened. It keeps running in the system tray.`);
  } catch (err) {
    console.error(styleText('red', err.message));
    process.exit(1);
  }
}
