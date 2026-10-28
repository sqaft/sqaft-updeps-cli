# @sqaft/updeps-cli

**Durum:** Yayında  
**Tür:** Bağımsız kütüphane / ürün

A language- and package-manager-agnostic macOS CLI and background service (launchd daemon) that, when a package is pushed, updates the repos that depend on it. Published on npm as `@sqaft/updeps-cli`; public repo: github.com/sqaft/sqaft-updeps-cli. Details: `README.md`, `updeps --help`.

## Commands

- `npm test` — `node --test --test-force-exit 'test/*.test.js'`
- `npm start` — runs the daemon in the foreground

## Releases

The repo is versioned with semver because npm needs a new version for each publish; there are no git tags. To release:

1. Bump `version` in `package.json` and `package-lock.json`.
2. Commit and push to `main`.

The `publish` job in `.github/workflows/test.yml` then publishes to npm with trusted publishing (OIDC, no token) and provenance, after the tests pass and only if that version is not on npm yet. The job upgrades npm to 11.5.1+ (required for trusted publishing) and needs `permissions: id-token: write`.

One-time setup: npm only lets you add a trusted publisher to a package that already exists, so the first version is published manually (`npm login`, then `npm publish` from the repo root; `prepublishOnly` runs the tests). A new trusted publisher expires unless it completes a publish within 2 days, so add it right before pushing the first version bump that CI should publish: on npmjs.com open the package settings, then Trusted publisher, and choose GitHub Actions with organization `sqaft`, repository `sqaft-updeps-cli`, workflow file `test.yml` (no environment). If it expires, delete it and add it again. Optionally restrict publishing to trusted publishing only ("Require two-factor authentication and disallow tokens").

Breaking changes to the config format, the state/journal files, or CLI commands and flags follow semver (while the version is 0.x, bump the minor).

## Notes

- All code, comments, docs, CLI output and tests are in English.
- The tool runs **live** on this machine: the global `updeps` is `npm link`ed to this working copy and the launchd daemon runs it. It executes commands in real repos, so do not break the installed daemon or the real config (`reset`, `remove`, `stop`, `run`); test with `--dry-run` and the test fixtures. After code changes, run `updeps restart` so the daemon picks them up.
- If CLI commands or options change, update `--help` and `README.md` too.
- The SwiftBar/xbar plugin renders the output of `updeps menubar`; check it when that output changes.
