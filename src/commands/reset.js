import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';
import {
  CONFIG_FILE,
  LOCKS_DIR,
  LOG_FILE,
  STATE_FILE,
  tildify
} from '../paths.js';
import { resetState } from '../state.js';
import { JOURNAL_FILE, JOURNAL_FILE_1 } from '../journal.js';
import { runningDaemonPid, restartAgent } from '../daemon.js';

/**
 * Best-effort file removal. Never throws.
 * @param {string} p
 * @returns {boolean} true if a file was actually removed
 */
function rm(p) {
  try {
    if (!fs.existsSync(p)) return false;
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Empties the locks directory. Called only when no daemon owns a live lock.
 * @returns {number} how many lock dirs were removed
 */
function clearLocks() {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(LOCKS_DIR)) {
      if (rm(path.join(LOCKS_DIR, name))) removed++;
    }
  } catch {
    /* no locks dir */
  }
  return removed;
}

/**
 * @param {string} question
 * @returns {Promise<boolean>}
 */
async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return ['e', 'evet', 'y', 'yes'].includes(answer);
  } finally {
    rl.close();
  }
}

/**
 * Wipes every runtime artifact except the config file: run queue, open
 * failures, run history, per-repo SHA tracking, the journal, raw logs and
 * stale lock dirs. A running daemon is restarted afterwards so its in-memory
 * queue is flushed too (skip with `--keep-daemon`).
 * @param {{ yes?: boolean, 'keep-daemon'?: boolean }} opts
 */
export async function cmdReset(opts = {}) {
  const keepDaemon = opts['keep-daemon'] === true;
  const pid = runningDaemonPid();

  if (!opts.yes) {
    console.log(styleText('yellow', 'Bu işlem şunları KALICI olarak siler:'));
    console.log('  · bekleyen kuyruk ve çalışan iş kaydı');
    console.log('  · tüm açık hatalar');
    console.log('  · çalışma geçmişi (journal) ve ham loglar');
    console.log('  · repo başına işlenmiş SHA takibi ve kilitler');
    console.log(styleText('dim', `Korunur: ${tildify(CONFIG_FILE)}`));
    if (pid && !keepDaemon) {
      console.log(styleText('dim', `Daemon (pid ${pid}) yeniden başlatılır.`));
    }
    console.log('');

    if (!process.stdin.isTTY) {
      console.error(styleText('red', 'Onay gerekli. Etkileşimsiz ortamda: updeps reset --yes'));
      process.exit(1);
    }
    if (!(await confirm('Devam edilsin mi? [e/H] '))) {
      console.log('İptal edildi.');
      return;
    }
  }

  // 1. state.json → boş (daemon çalışıyorsa daemon bloğu korunur)
  resetState({ preserveDaemon: pid != null });
  const wipedState = fs.existsSync(STATE_FILE);

  // 2. journal + rotasyonu
  const wipedJournal = [JOURNAL_FILE, JOURNAL_FILE_1].map(rm).some(Boolean);

  // 3. ham log — launchd dosyayı açık tuttuğu için silmek yerine sıfırla
  let wipedLog = false;
  try {
    if (fs.existsSync(LOG_FILE)) {
      fs.truncateSync(LOG_FILE, 0);
      wipedLog = true;
    }
  } catch {
    /* ignore */
  }

  // 4. daemon: yeniden başlat (bellekteki kuyruğu da temizler)
  let daemonNote = '';
  if (pid && !keepDaemon) {
    try {
      restartAgent(); // kapanışta releaseHeldLocks() kilitleri de bırakır
      daemonNote = 'daemon yeniden başlatıldı';
    } catch (err) {
      daemonNote = styleText('red', `daemon yeniden başlatılamadı: ${err.message}`);
    }
  } else if (pid) {
    daemonNote = styleText('yellow', `daemon çalışıyor (pid ${pid}) — bellekteki kuyruk için "updeps restart" gerekir`);
  }

  // 5. kilitler — daemon durmuşsa güvenle temizle
  const daemonStopped = runningDaemonPid() == null;
  const locksRemoved = daemonStopped || !keepDaemon ? clearLocks() : 0;

  const done = [];
  if (wipedState) done.push('kuyruk + hatalar + geçmiş');
  if (wipedJournal) done.push('journal');
  if (wipedLog) done.push('loglar');
  if (locksRemoved) done.push(`${locksRemoved} kilit`);

  console.log(styleText('green', `Temizlendi: ${done.join(', ') || 'zaten boştu'}`));
  if (daemonNote) console.log(styleText('dim', daemonNote));
}
