import { shellQuote } from './exec.js';

/**
 * @typedef {object} TemplateVars
 * @property {string} pkg          triggering source repo's package name
 * @property {string[]} pkgList    all package identifiers to update for this target
 * @property {string} sha          full sha of the triggering commit
 * @property {string} sourcePath
 * @property {string} sourceBranch
 * @property {string} targetPath
 * @property {string} targetBranch
 */

/**
 * Builds the substitution map from resolved variables.
 * @param {TemplateVars} vars
 * @returns {Record<string,string>}
 */
function buildMap(vars) {
  const shortSha = (vars.sha || '').slice(0, 7);
  const pkgs = (vars.pkgList && vars.pkgList.length ? vars.pkgList : [vars.pkg])
    .filter(Boolean);
  return {
    pkg: vars.pkg || '',
    pkgs: pkgs.map(shellQuote).join(' '),
    sha: shortSha,
    bumps: `${vars.pkg || ''}@${shortSha}`,
    sourcePath: vars.sourcePath || '',
    sourceBranch: vars.sourceBranch || '',
    targetPath: vars.targetPath || '',
    targetBranch: vars.targetBranch || '',
    // aliases kept for familiarity with the old hook
    branch: vars.targetBranch || '',
    repoPath: vars.targetPath || ''
  };
}

/**
 * Interpolates {name} placeholders in a command string. Values that come from
 * config-derived data are already shell-quoted where relevant (pkgs).
 * @param {string} template
 * @param {TemplateVars} vars
 * @returns {string}
 */
export function interpolateCommand(template, vars) {
  const map = buildMap(vars);
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(map, key) ? map[key] : match
  );
}

/**
 * Interpolates {name} placeholders in a commit message. The result is passed to
 * git via argv, never through a shell, so no quoting is applied here.
 * @param {string} template
 * @param {TemplateVars} vars
 * @returns {string}
 */
export function interpolateMessage(template, vars) {
  const map = buildMap(vars);
  // pkgs in a commit message reads better unquoted
  map.pkgs = (vars.pkgList && vars.pkgList.length ? vars.pkgList : [vars.pkg])
    .filter(Boolean)
    .join(', ');
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(map, key) ? map[key] : match
  );
}
