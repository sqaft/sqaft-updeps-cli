import path from 'node:path';

/**
 * Parses a single line from a git reflog file.
 * Format: <old-sha> <new-sha> Author <email> <timestamp> <tz>\t<message>
 * @param {string} line
 * @returns {object|null}
 */
export function parseReflogLine(line) {
  if (!line || typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed) return null;

  const tabIndex = trimmed.indexOf('\t');
  if (tabIndex === -1) return null;

  const metaPart = trimmed.slice(0, tabIndex);
  const message = trimmed.slice(tabIndex + 1).trim();

  const parts = metaPart.split(' ');
  if (parts.length < 6) return null;

  const oldSha = parts[0];
  const newSha = parts[1];
  const tz = parts[parts.length - 1];
  const timestamp = parseInt(parts[parts.length - 2], 10);
  const emailWithBrackets = parts[parts.length - 3];
  const email = emailWithBrackets ? emailWithBrackets.replace(/[<>]/g, '') : '';
  const author = parts.slice(2, parts.length - 3).join(' ');

  return {
    oldSha,
    newSha,
    author,
    email,
    timestamp: isNaN(timestamp) ? Date.now() : timestamp * 1000,
    tz,
    message
  };
}

/**
 * Classifies a reflog file path and parsed reflog entry.
 * @param {string} reflogFilePath Relative or absolute path to .git/logs/refs/...
 * @param {object} parsedLine Parsed reflog line
 * @returns {{ trigger: 'push'|'fetch'|'commit'|'merge'|'unknown', branch: string, remote?: string, sha: string } | null}
 */
export function classifyReflogEvent(reflogFilePath, parsedLine) {
  if (!parsedLine || !parsedLine.newSha) return null;

  const normalizedPath = reflogFilePath.replace(/\\/g, '/');
  const msg = (parsedLine.message || '').toLowerCase();
  const sha = parsedLine.newSha;

  // Remote reflog: .git/logs/refs/remotes/<remote>/<branch...>
  const remoteMatch = normalizedPath.match(/\/refs\/remotes\/([^/]+)\/(.+)$/);
  if (remoteMatch) {
    const remote = remoteMatch[1];
    const branch = remoteMatch[2];

    if (msg.includes('update by push')) {
      return { trigger: 'push', branch, remote, sha };
    }
    if (msg.startsWith('fetch') || msg.includes('fetch')) {
      return { trigger: 'fetch', branch, remote, sha };
    }

    return { trigger: 'push', branch, remote, sha };
  }

  // Local heads reflog: .git/logs/refs/heads/<branch...>
  const localMatch = normalizedPath.match(/\/refs\/heads\/(.+)$/);
  if (localMatch) {
    const branch = localMatch[1];

    if (msg.startsWith('commit')) {
      return { trigger: 'commit', branch, sha };
    }
    if (msg.startsWith('merge') || msg.startsWith('pull')) {
      return { trigger: 'merge', branch, sha };
    }

    return { trigger: 'commit', branch, sha };
  }

  return null;
}
