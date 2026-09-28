import fs from 'node:fs';

/**
 * Reads the last non-empty line of a (reflog) file without loading it all.
 * @param {string} filePath
 * @returns {string|null}
 */
export function readLastLine(filePath) {
  try {
    const { size } = fs.statSync(filePath);
    if (size === 0) return null;
    const chunk = Math.min(8192, size);
    const buf = Buffer.alloc(chunk);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, chunk, size - chunk);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim() !== '');
    return lines.length ? lines[lines.length - 1] : null;
  } catch {
    return null;
  }
}

/**
 * Parses one reflog line.
 * Format: `<old-sha> <new-sha> Name <email> <unix-ts> <tz>\t<message>`
 * @param {string} line
 * @returns {{ oldSha:string, newSha:string, message:string, timestamp:number }|null}
 */
export function parseReflogLine(line) {
  if (typeof line !== 'string') return null;
  const tab = line.indexOf('\t');
  if (tab === -1) return null;
  const meta = line.slice(0, tab).trim();
  const message = line.slice(tab + 1).trim();
  const parts = meta.split(' ');
  if (parts.length < 6) return null;

  const oldSha = parts[0];
  const newSha = parts[1];
  const ts = parseInt(parts[parts.length - 2], 10);
  if (!/^[0-9a-f]{7,40}$/.test(newSha)) return null;

  return {
    oldSha,
    newSha,
    message,
    timestamp: Number.isNaN(ts) ? Date.now() : ts * 1000
  };
}

/**
 * Classifies a reflog file path + parsed line into an event.
 * @param {string} reflogPath  absolute or relative path under .git/logs/refs/
 * @param {ReturnType<typeof parseReflogLine>} parsed
 * @returns {{ trigger:'push'|'fetch'|'commit'|'merge', branch:string, remote?:string, sha:string }|null}
 */
export function classifyReflogEvent(reflogPath, parsed) {
  if (!parsed) return null;
  const norm = reflogPath.replace(/\\/g, '/');
  const msg = parsed.message.toLowerCase();
  const sha = parsed.newSha;

  const remote = norm.match(/\/logs\/refs\/remotes\/([^/]+)\/(.+)$/);
  if (remote) {
    const [, remoteName, branch] = remote;
    if (msg.includes('update by push')) return { trigger: 'push', branch, remote: remoteName, sha };
    // `git pull` writes "pull <remote> <branch>: fast-forward" / "storing head"
    // to this same remote-tracking reflog — it's someone else's push landing
    // locally via fetch, not a push of ours, so it must never be classified as one.
    if (msg.startsWith('fetch') || msg.includes(': fetch') || msg.startsWith('pull')) {
      return { trigger: 'fetch', branch, remote: remoteName, sha };
    }
    // unrecognized remote-tracking update — don't guess, ignore it
    return null;
  }

  const head = norm.match(/\/logs\/refs\/heads\/(.+)$/);
  if (head) {
    const [, branch] = head;
    if (msg.startsWith('commit')) return { trigger: 'commit', branch, sha };
    if (msg.startsWith('merge') || msg.startsWith('pull')) return { trigger: 'merge', branch, sha };
    return { trigger: 'commit', branch, sha };
  }

  return null;
}
