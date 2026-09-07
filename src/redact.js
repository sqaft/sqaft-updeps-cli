/**
 * Masks credentials that package managers routinely echo (git remote URLs with
 * embedded tokens, GitHub PATs, npm/bearer tokens) so they never reach the log
 * file, the journal, or a notification.
 *
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  if (!text) return text;
  let out = String(text);

  // https://user:token@host  →  https://***@host   (also http, git://, ssh://)
  out = out.replace(
    /((?:https?|git|ssh|ftp):\/\/)[^/\s:@]+:[^/\s@]+@/gi,
    '$1***@'
  );
  // https://token@host       →  https://***@host
  out = out.replace(/((?:https?|git|ssh|ftp):\/\/)[^/\s:@]{8,}@/gi, '$1***@');

  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_...
  out = out.replace(/\bgh[posur]_[A-Za-z0-9]{16,}\b/g, 'gh*_***');
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_***');

  // GitLab / generic "glpat-", Slack "xox.-", AWS "AKIA...", npm "npm_"
  out = out.replace(/\bglpat-[A-Za-z0-9_-]{16,}\b/g, 'glpat-***');
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'xox*-***');
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***');
  out = out.replace(/\bnpm_[A-Za-z0-9]{36}\b/g, 'npm_***');

  // Authorization: Bearer <jwt-ish>
  out = out.replace(/(authorization:\s*(?:bearer|token)\s+)\S+/gi, '$1***');
  // //registry.example/:_authToken=...
  out = out.replace(/(_authToken=)\S+/gi, '$1***');
  // x-access-token:<tok> / oauth2:<tok>
  out = out.replace(/\b(x-access-token|oauth2|x-oauth-basic):[^\s@/]+/gi, '$1:***');

  return out;
}
