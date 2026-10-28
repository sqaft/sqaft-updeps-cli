# @sqaft/updeps-cli

**Durum:** Yayında  
**Tür:** Bağımsız kütüphane / ürün

A language- and package-manager-agnostic CLI and background service for macOS, Linux and Windows that, when a package is pushed, updates the repos that depend on it. Published on npm as `@sqaft/updeps-cli`; public repo: github.com/sqaft/sqaft-updeps-cli. Details: `README.md`, `updeps --help`.

The desktop app (dependency graph editor + system tray) lives in the `sqaft-updeps-app` repo (`@sqaft/updeps-app` on npm). It uses this package through `@sqaft/updeps-cli/api` (`src/api.js`) and runs the CLI for actions, so changes to the API, the CLI commands it runs, or the state/journal format must be checked against it.

## Layout

- `src/service/`: how the daemon is kept running per platform: `launchd.js` (macOS), `systemd.js` (Linux), `startup.js` (Windows Startup-folder script), `supervised.js` (the `updeps daemon --supervise` supervisor used on Windows and on Linux without systemd); `index.js` picks one.
- `src/control.js`: the daemon's control channel (Unix socket / named pipe), used to stop a supervised daemon.
- `src/launcher.js`: Node/CLI lookup shared by the service definitions and the menubar plugin.
- `src/commands/gui.js`: `updeps gui`; installs `@sqaft/updeps-app` with npm into `DESKTOP_APP_DIR` (`src/paths.js`) and runs its `bin/updeps-app.js` with `UPDEPS_CLI` set to this package.

## Commands

- `npm test` — `node --test --test-force-exit --import ./test/setup.js "test/*.test.js"` (`test/setup.js` points XDG_CONFIG_HOME / XDG_STATE_HOME at a temp dir so tests never touch the real config/state, and turns off `core.autocrlf` for the test repos)
- Linux tests locally: `docker run --rm -v "$PWD":/src:ro node:22-bookworm bash -c 'cp -r /src /app && cd /app && rm -rf node_modules && npm ci && npm test'`. Windows is covered by the CI matrix (`.github/workflows/test.yml`). Test commands in POSIX syntax run through `TEST_SHELL` (`test/helpers.js`: Git for Windows' bash on Windows).
- `npm start` — runs the daemon in the foreground

## Releases

The repo is versioned with semver because npm needs a new version for each publish; there are no git tags. To release:

1. Bump `version` in `package.json` and `package-lock.json`.
2. Commit and push to `main`.

The `publish` job in `.github/workflows/test.yml` then publishes to npm with trusted publishing (OIDC, no token) and provenance, after the tests pass on macOS, Linux and Windows and only if that version is not on npm yet. The job upgrades npm to 11.5.1+ (required for trusted publishing) and needs `permissions: id-token: write`.

One-time setup: npm only lets you add a trusted publisher to a package that already exists, so the first version is published manually (`npm login`, then `npm publish` from the repo root; `prepublishOnly` runs the tests). A new trusted publisher expires unless it completes a publish within 2 days, so add it right before pushing the first version bump that CI should publish: on npmjs.com open the package settings, then Trusted publisher, and choose GitHub Actions with organization `sqaft`, repository `sqaft-updeps-cli`, workflow file `test.yml` (no environment). If it expires, delete it and add it again. Optionally restrict publishing to trusted publishing only ("Require two-factor authentication and disallow tokens").

Breaking changes to the config format, the state/journal files, CLI commands and flags, or `@sqaft/updeps-cli/api` follow semver (while the version is 0.x, bump the minor).

## Notes

- All code, comments, docs, CLI output and tests are in English.
- The tool runs **live** on this machine: the global `updeps` is `npm link`ed to this working copy and the launchd daemon runs it. It executes commands in real repos, so do not break the installed daemon or the real config (`reset`, `remove`, `stop`, `run`); test with `--dry-run` and the test fixtures. After code changes, run `updeps restart` so the daemon picks them up.
- Platform-specific code goes behind `process.platform` checks with the macOS behavior unchanged; never assume `/`, `:` (use `path.sep`, `path.delimiter`), signals (Windows has none a process can handle), process groups, or a POSIX shell.
- If CLI commands or options change, update `--help` and `README.md` too.
- The SwiftBar/xbar plugin renders the output of `updeps menubar`; check it when that output changes.
