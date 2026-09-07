import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';
import { loadState } from '../state.js';
import { runningDaemonPid } from '../daemon.js';
import { resolveHome, tildify } from '../paths.js';

const BIN_PATH = fileURLToPath(new URL('../../bin/updeps.js', import.meta.url));

/**
 * Prints SwiftBar/xbar plugin output. Reads only state.json — no git calls.
 * @param {{ install?: boolean }} opts
 */
export function cmdMenubar(opts = {}) {
  if (opts.install) return install();

  const state = loadState();
  const pid = runningDaemonPid();

  const lastRun = (state.lastRuns || [])[0];
  const failures = state.openFailures || [];
  const active = state.activeRun;
  const queued = state.queue?.jobs || [];

  // Menu bar title line
  const inFlight = queued.length + (active ? 1 : 0); // running + waiting
  const icon = !pid ? '⏸' : active ? '↻' : failures.length ? '⚠' : '⇅';
  const badge = [
    failures.length ? ` ⚠${failures.length}` : '',
    inFlight ? ` ⧗${inFlight}` : ''
  ].join('');
  console.log(`${icon}${badge}`);
  console.log('---');

  console.log(pid ? `Daemon çalışıyor (pid ${pid}) | color=green` : 'Daemon kapalı | color=orange');

  if (active) {
    console.log(
      `▶ ${active.source} → ${active.target}${queued.length ? ` (+${queued.length} kuyrukta)` : ''} | color=blue`
    );
  }

  if (queued.length > 0) {
    console.log(`Kuyrukta (${queued.length}) | color=gray`);
    for (const j of queued.slice(0, 10)) {
      const from = j.sources?.length ? ` ← ${j.sources.join(', ')}` : '';
      console.log(`· ${j.target}${from} | size=11 color=gray`);
    }
    if (queued.length > 10) console.log(`… +${queued.length - 10} | size=11 color=gray`);
  }

  if (lastRun) {
    const d = new Date(lastRun.timestamp).toLocaleString();
    console.log(
      `Son: ${lastRun.sourceRepo} → ${lastRun.committed} commit, ${lastRun.failed} hata | color=${lastRun.failed ? 'red' : 'gray'}`
    );
    console.log(`${d} | size=11 color=gray`);
  }

  if (failures.length > 0) {
    console.log('---');
    console.log(`Açık hatalar (${failures.length}) | color=red`);
    for (const f of failures.slice(0, 8)) {
      const times = f.count > 1 ? ` ×${f.count}` : '';
      console.log(
        `${f.source} → ${f.target}${times}: ${f.message} | size=11 color=red ` +
          `bash="${process.execPath}" param1="${BIN_PATH}" param2="show" param3="${f.target}" terminal=true`
      );
    }
    console.log(
      `↻ Hepsini yeniden dene | color=red bash="${process.execPath}" param1="${BIN_PATH}" param2="retry" param3="--failed" terminal=true`
    );
  }

  console.log('---');
  console.log(`Durum | bash="${process.execPath}" param1="${BIN_PATH}" param2="status" terminal=true`);
  console.log(`Geçmiş | bash="${process.execPath}" param1="${BIN_PATH}" param2="history" terminal=true`);
  console.log(`Loglar | bash="${process.execPath}" param1="${BIN_PATH}" param2="logs" param3="-f" terminal=true`);
  console.log('Bakım | color=gray');
  console.log(
    `--Verileri temizle (kuyruk + hatalar) | color=red terminal=true refresh=true ` +
      `bash="${process.execPath}" param1="${BIN_PATH}" param2="reset"`
  );
  console.log(`Yenile | refresh=true`);
}

/**
 * Reads a `defaults` string value, or '' if unset/unavailable.
 * @param {string} domain
 * @param {string} key
 * @returns {string}
 */
function defaultsRead(domain, key) {
  try {
    return execFileSync('defaults', ['read', domain, key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/**
 * Resolves the folder SwiftBar (or xbar) actually scans for plugins.
 * @returns {{ dir: string, source: string } | null}
 */
function resolvePluginDir() {
  const swiftbarPref = defaultsRead('com.ameba.SwiftBar', 'PluginDirectory');
  const xbarPref =
    defaultsRead('com.xbarapp.osx', 'pluginsDirectory') ||
    defaultsRead('com.xbarapp.osx', 'PluginDirectory');

  const candidates = [
    process.env.SWIFTBAR_PLUGINS_PATH && { dir: process.env.SWIFTBAR_PLUGINS_PATH, source: '$SWIFTBAR_PLUGINS_PATH' },
    swiftbarPref && { dir: swiftbarPref, source: 'SwiftBar ayarı' },
    xbarPref && { dir: xbarPref, source: 'xbar ayarı' },
    { dir: path.join(os.homedir(), '.config', 'xbar', 'plugins'), source: 'xbar varsayılanı' }
  ].filter(Boolean);

  for (const c of candidates) {
    const dir = resolveHome(c.dir);
    if (fs.existsSync(dir)) return { dir, source: c.source };
  }
  return null;
}

function install() {
  const swiftBarInstalled = fs.existsSync('/Applications/SwiftBar.app');
  const found = resolvePluginDir();

  let dir;
  if (found) {
    dir = found.dir;
  } else if (swiftBarInstalled) {
    // SwiftBar is installed but hasn't been pointed at a folder yet.
    dir = path.join(os.homedir(), '.swiftbar');
    fs.mkdirSync(dir, { recursive: true });
    console.log(
      styleText('yellow', `SwiftBar bir plugin klasörüne ayarlı değil. ${tildify(dir)} oluşturuldu.`) +
        '\nSwiftBar → Preferences → "Plugin Folder" olarak bunu seç.'
    );
  } else {
    console.error(
      styleText('red', 'SwiftBar/xbar bulunamadı.') +
        '\nSwiftBar kur (brew install --cask swiftbar), plugin klasörünü seç, sonra tekrar dene.'
    );
    process.exit(1);
  }

  const pluginPath = path.join(dir, 'updeps.30s.sh');
  const script = `#!/usr/bin/env bash
# <xbar.title>updeps</xbar.title>
# <xbar.desc>Bağımlı repo güncelleme durumu</xbar.desc>
exec "${process.execPath}" "${BIN_PATH}" menubar
`;
  fs.writeFileSync(pluginPath, script, { mode: 0o755 });

  // Remove stale copies an older `--install` may have left in the wrong place.
  const stale = path.join(os.homedir(), 'Library', 'Application Support', 'SwiftBar', 'updeps.30s.sh');
  if (stale !== pluginPath && fs.existsSync(stale)) {
    try {
      fs.rmSync(stale);
      console.log(styleText('dim', `Eski kopya silindi: ${tildify(stale)}`));
    } catch {
      /* ignore */
    }
  }

  console.log(styleText('green', `Kuruldu: ${pluginPath}`) + styleText('dim', ` (${found ? found.source : 'yeni klasör'})`));
  console.log(styleText('dim', 'SwiftBar menüsünden "Refresh All" ile görünür.'));
}
