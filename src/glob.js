/**
 * A small, dependency-free glob matcher. Patterns are matched against
 * `/`-separated paths relative to the repo root (as `git status` prints them).
 *
 * Syntax:
 * - `*`     any run of characters except `/` (may be empty)
 * - `?`     exactly one character except `/`
 * - `**`    as a whole path segment: zero or more directories
 *           (`**` + `/x`, `a/**` + `/b`, `a/**`)
 * - `{a,b}` one of the alternatives (no nesting)
 *
 * A pattern without `/` matches the file name at any depth (`yarn.lock`
 * matches `yarn.lock` and `packages/web/yarn.lock`). A pattern that starts
 * with `/` or contains a `/` is anchored to the repo root. A trailing `/`
 * matches everything below that directory. `!` negation is not supported.
 */

const REGEX_SPECIAL = /[.+^$()|[\]\\]/;

/**
 * Turns a pattern body (anchoring already decided) into regex source.
 * @param {string} body
 * @returns {string}
 */
function bodyToRegex(body) {
  let re = '';
  let inBrace = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '*') {
      if (body[i + 1] === '*') {
        const atSegmentStart = i === 0 || body[i - 1] === '/';
        const next = body[i + 2];
        if (atSegmentStart && next === '/') {
          re += '(?:[^/]*/)*';
          i += 2;
          continue;
        }
        if (atSegmentStart && next === undefined) {
          re += '.*';
          i += 1;
          continue;
        }
        // `**` that is not a whole segment (e.g. `a**b`) acts like `*`
        re += '[^/]*';
        i += 1;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      if (inBrace) throw new Error("iç içe '{' desteklenmez");
      if (!body.includes('}', i + 1)) throw new Error("kapanmayan '{'");
      inBrace = true;
      re += '(?:';
    } else if (c === '}') {
      if (!inBrace) throw new Error("eşi olmayan '}'");
      inBrace = false;
      re += ')';
    } else if (c === ',' && inBrace) {
      re += '|';
    } else {
      re += REGEX_SPECIAL.test(c) ? `\\${c}` : c;
    }
  }
  return re;
}

/**
 * Compiles a glob pattern. Throws an Error with a (Turkish, user-facing)
 * explanation for an invalid pattern.
 * @param {string} pattern
 * @returns {RegExp}
 */
export function compileGlob(pattern) {
  if (typeof pattern !== 'string' || pattern.trim() === '') throw new Error('desen boş olamaz');
  if (pattern.startsWith('!')) throw new Error("'!' ile olumsuzlama desteklenmez");

  let p = pattern.startsWith('./') ? pattern.slice(2) : pattern;
  const anchored = p.startsWith('/');
  p = p.replace(/^\/+/, '');
  const dirOnly = p.endsWith('/');
  p = p.replace(/\/+$/, '');
  if (p === '') throw new Error('desen yalnızca "/" olamaz');

  const floating = !anchored && !p.includes('/');
  let body = dirOnly ? `${p}/**` : p;
  if (floating) body = `**/${body}`;
  return new RegExp(`^${bodyToRegex(body)}$`);
}

/**
 * Builds a path predicate from a pattern list: true when the path matches at
 * least one pattern.
 * @param {string[]} patterns
 * @returns {(filePath: string) => boolean}
 */
export function createPathMatcher(patterns) {
  const regexes = patterns.map(compileGlob);
  return (filePath) => regexes.some((re) => re.test(filePath));
}
