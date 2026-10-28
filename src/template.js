import { shellQuote, shellKind } from './exec.js';

/**
 * @typedef {object} TemplateVars
 * @property {string} pkg          triggering source repo's package name
 * @property {string[]} pkgList    all package identifiers to update for this target
 * @property {string} sha          full sha of the triggering commit
 * @property {Array<{name:string, sha:string}>} [sources]  every source whose trigger
 *   coalesced into this run (a target with `coalesce: true` hit by several pushes in
 *   one debounce window); falls back to a single `{pkg, sha}` entry when absent
 * @property {string} sourcePath
 * @property {string} sourceBranch
 * @property {string} targetPath
 * @property {string} targetBranch
 * @property {string|null} [shell]  the target's `shell` setting; decides how `{pkgs}` is quoted in commands
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
  const bumpSources = vars.sources && vars.sources.length ? vars.sources : [{ name: vars.pkg, sha: vars.sha }];
  return {
    pkg: vars.pkg || '',
    pkgs: pkgs.map((p) => shellQuote(p, shellKind(vars.shell))).join(' '),
    sha: shortSha,
    bumps: bumpSources.map((s) => `${s.name || ''}@${(s.sha || '').slice(0, 7)}`).join(', '),
    sourcePath: vars.sourcePath || '',
    sourceBranch: vars.sourceBranch || '',
    targetPath: vars.targetPath || '',
    targetBranch: vars.targetBranch || ''
  };
}

/**
 * Interpolates {name} placeholders in a command string. Values that come from
 * config-derived data are already shell-quoted where relevant (pkgs), for the
 * shell the command runs in.
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
