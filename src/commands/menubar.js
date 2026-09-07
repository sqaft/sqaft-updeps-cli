import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';
import { loadState } from '../state.js';
import { runningDaemonPid } from '../daemon.js';
import { tildify } from '../paths.js';

const BIN_PATH = fileURLToPath(new URL('../../bin/updeps.js', import.meta.url));

/**
 * Prints SwiftBar/xbar plugin output. Reads only state.json — no git calls.
 * @param {{ install?: boolean }} opts
 */
export function cmdMenubar(opts = {}) {
  if (opts.install) return install();

  const state = loadState();
  const pid = runningDaemonPid();

  const pending = Object.values(state.repos || {}).reduce(
    (sum, r) => sum + (r.pendingPushCount || 0),
    0
  );
  const lastRun = (state.lastRuns || [])[0];
  const anyFailed = (state.errors || []).length > 0;

  // Menu bar title line
  const icon = !pid ? '⏸' : anyFailed ? '⚠' : '⇅';
  console.log(`${icon}${pending > 0 ? ` ⇡${pending}` : ''}`);
  console.log('---');

  console.log(pid ? `Daemon çalışıyor (pid ${pid}) | color=green` : 'Daemon kapalı | color=orange');

  if (lastRun) {
    const d = new Date(lastRun.timestamp).toLocaleString();
    console.log(
      `Son: ${lastRun.sourceRepo} → ${lastRun.committed} commit, ${lastRun.failed} hata | color=${lastRun.failed ? 'red' : 'gray'}`
    );
    console.log(`${d} | size=11 color=gray`);
  }

  if (pending > 0) {
    console.log('---');
    console.log(`${pending} commit push bekliyor | color=orange`);
    for (const [p, r] of Object.entries(state.repos || {})) {
      if (r.pendingPushCount > 0) {
        console.log(`⇡${r.pendingPushCount} ${tildify(p)} | size=11`);
      }
    }
  }

  if ((state.errors || []).length > 0) {
    console.log('---');
    console.log('Hatalar | color=red');
    for (const e of state.errors.slice(0, 5)) {
      console.log(`${e.target}: ${e.message} | size=11 color=red`);
    }
  }

  console.log('---');
  console.log(`Durum | bash="${process.execPath}" param1="${BIN_PATH}" param2="status" terminal=true`);
  console.log(`Loglar | bash="${process.execPath}" param1="${BIN_PATH}" param2="logs" param3="-f" terminal=true`);
  console.log(`Yenile | refresh=true`);
}

function install() {
  const pluginsDir = path.join(os.homedir(), 'Library', 'Application Support', 'SwiftBar');
  const candidates = [
    process.env.SWIFTBAR_PLUGINS_PATH,
    pluginsDir,
    path.join(os.homedir(), '.config', 'xbar', 'plugins')
  ].filter(Boolean);

  const dir = candidates.find((d) => fs.existsSync(d));
  if (!dir) {
    console.error(
      styleText('red', 'SwiftBar/xbar plugin klasörü bulunamadı.') +
        '\nSwiftBar kur (brew install swiftbar), plugin klasörünü seç, sonra tekrar dene.'
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
  console.log(styleText('green', `Kuruldu: ${pluginPath}`));
  console.log(styleText('dim', 'SwiftBar menüsünden "Refresh All" ile görünür.'));
}
