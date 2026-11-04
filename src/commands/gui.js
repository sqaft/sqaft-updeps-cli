import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { styleText } from 'node:util';
import { DESKTOP_APP_DIR, tildify } from '../paths.js';
import { confirm } from '../prompt.js';
import { APP_PACKAGE, CLI_ROOT, checkUpdates, isNewer } from '../updates.js';

export { APP_PACKAGE };

/** Where `updeps gui install` puts the app's package. */
const INSTALLED_ROOT = path.join(DESKTOP_APP_DIR, 'node_modules', ...APP_PACKAGE.split('/'));

/**
 * The desktop app this CLI opens: the checkout in `UPDEPS_GUI` when set (for
 * development), otherwise the one `updeps gui install` put in DESKTOP_APP_DIR.
 * @returns {{ root: string, version: string, bin: string } | null} null when it is not installed
 */
export function findApp() {
  return readApp(process.env.UPDEPS_GUI || INSTALLED_ROOT);
}

/**
 * The app `updeps gui install` manages (in DESKTOP_APP_DIR), whatever `UPDEPS_GUI` says.
 * @returns {{ root: string, version: string, bin: string } | null}
 */
export function installedApp() {
  return readApp(INSTALLED_ROOT);
}

/**
 * @param {string} root  an app package directory
 * @returns {{ root: string, version: string, bin: string } | null}
 */
function readApp(root) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['updeps-gui'];
  if (pkg.name !== APP_PACKAGE || typeof rel !== 'string') return null;
  const bin = path.join(root, rel);
  return fs.existsSync(bin) ? { root, version: pkg.version, bin } : null;
}

/**
 * Asks a running desktop app to quit (`updeps-gui --quit`: waits until it is
 * gone, exits 0 also when none is running), so an update can replace its files.
 * @param {{ bin: string }} app
 * @param {typeof spawnSync} [spawn]
 * @returns {boolean} false when the app could not be asked, for example because
 *   its version does not know `--quit`
 */
export function quitApp(app, spawn = spawnSync) {
  const res = spawn(process.execPath, [app.bin, '--quit'], { stdio: 'ignore', timeout: 20_000, windowsHide: true });
  return !res.error && res.status === 0;
}

/**
 * Installs the latest app (or updates it) into DESKTOP_APP_DIR with npm. The
 * directory is an npm project of its own, so nothing is installed globally
 * and no administrator rights are needed. An installed app that is running is
 * asked to quit first; when that does not work the update goes ahead anyway
 * and the user is told to restart the app.
 * @param {{ spawn?: typeof spawnSync }} [deps]  process runner, replaced in tests
 * @returns {{ root: string, version: string, bin: string }}
 */
export function installApp({ spawn = spawnSync } = {}) {
  const previous = installedApp();
  const quitFailed = previous ? !quitApp(previous, spawn) : false;
  fs.mkdirSync(DESKTOP_APP_DIR, { recursive: true });
  const manifest = path.join(DESKTOP_APP_DIR, 'package.json');
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(
      manifest,
      JSON.stringify({ private: true, description: 'The updeps desktop app, installed by "updeps gui install".' }, null, 2) + '\n'
    );
  }
  // npm is a .cmd script on Windows, which Node only runs through a shell.
  const res = spawn('npm', ['install', '--prefix', DESKTOP_APP_DIR, `${APP_PACKAGE}@latest`, '--no-audit', '--no-fund'], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (res.error) throw new Error(`Could not run npm: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`npm install ${APP_PACKAGE} failed (exit code ${res.status}).`);
  const app = installedApp();
  if (!app) throw new Error(`npm finished, but ${APP_PACKAGE} is not in ${tildify(DESKTOP_APP_DIR)}.`);
  prepareApp(app, spawn);
  if (quitFailed) {
    console.log(styleText('dim', 'If the desktop app is still running, quit it from the tray and run "updeps gui" again.'));
  }
  return app;
}

/**
 * Runs the app's own setup (`updeps-gui --prepare`): Electron downloads its
 * binary the first time it is required, not when npm installs it, and on
 * macOS the app builds its updeps.app bundle. Doing that during the install
 * makes the first `updeps gui` open right away and reports a failure now.
 * @param {{ bin: string }} app
 * @param {typeof spawnSync} spawn
 */
function prepareApp(app, spawn) {
  const res = spawn(process.execPath, [app.bin, '--prepare'], { stdio: 'inherit' });
  if (res.error || res.status !== 0) throw new Error('Preparing the desktop app failed. Run "updeps gui install" again.');
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

const INSTALL_NOTE = 'It is installed with npm and downloads Electron (about 100 MB, 350 MB on disk).';

/**
 * Before `updeps gui` opens the installed app: when a terminal is attached,
 * looks up the latest published version (always, no cache) and, if it is newer,
 * asks whether to update first. Asked every time, since the command was typed
 * on purpose. A failed update still opens the installed app. Skipped for a
 * checkout in `UPDEPS_GUI`, with UPDEPS_NO_NOTICES set, and outside a terminal.
 * @param {{ root: string, version: string, bin: string }} app
 * @param {object} [deps]  replaced in tests
 * @returns {Promise<{ root: string, version: string, bin: string }>} the app to open
 */
export async function offerAppUpdate(app, deps = {}) {
  const {
    env = process.env,
    tty = Boolean(process.stdin.isTTY && process.stdout.isTTY),
    check = checkUpdates,
    ask = confirm,
    install = installApp
  } = deps;
  if (!tty || env.UPDEPS_GUI || env.UPDEPS_NO_NOTICES) return app;

  const latest = (await check({ force: true, timeoutMs: 3000 })).app.latest;
  if (!isNewer(latest, app.version)) return app;

  console.log(`Desktop app ${latest} is available (installed: ${app.version}). Updating closes the running app.`);
  if (!(await ask('Update now? [Y/n] '))) return app;
  try {
    const updated = install();
    console.log(styleText('green', `Desktop app ${updated.version} installed.`));
    return updated;
  } catch (err) {
    const remaining = findApp();
    if (!remaining) throw err;
    console.error(styleText('red', err.message));
    return remaining;
  }
}

/**
 * `updeps gui` opens the desktop app, offering to install it first (or to
 * update it when a newer version is published, see `offerAppUpdate`);
 * `updeps gui install` installs or updates it, saying so when the installed
 * version is already the latest; `updeps gui uninstall` removes it.
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
      const before = installedApp();
      if (before) {
        const latest = (await checkUpdates({ force: true, timeoutMs: 3000 })).app.latest;
        if (latest && !isNewer(latest, before.version)) {
          console.log(`Desktop app ${before.version} is up to date.`);
          return;
        }
      }
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
    } else {
      app = await offerAppUpdate(app);
    }
    openApp(app);
    console.log(`Desktop app ${app.version} opened. It keeps running in the system tray.`);
  } catch (err) {
    console.error(styleText('red', err.message));
    process.exit(1);
  }
}
