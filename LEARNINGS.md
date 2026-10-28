# LEARNINGS

## 2026-10-01 — Squash with `commit-tree` + `update-ref` instead of `reset --soft` + `commit`
`git reset --soft HEAD~n` followed by `git commit -- <files>` (`--only` semantics) commits the files with their **current** working tree contents; if the user later made dirty changes to a file from an earlier updeps commit, those end up in the commit too. Instead, the normal update commit is made first, then `git commit-tree <same tree> -p <base>` produces a single commit and `git update-ref <ref> <new> <old>` moves the branch tip: the index and working tree are untouched, the tree stays byte-for-byte identical, and because the ref update is a CAS it quietly gives up if a commit lands concurrently.

## 2026-10-01 — `updeps push` detects that a push was processed via `lastProcessedSha`
When all targets of a source's push are done, the daemon sets `state.repos[<source>].lastProcessedSha` to the `origin/<branch>` tip (even if every target was `skipped`). Knowing that the queue is empty and there is no `activeRun` is not enough on its own: the daemon looks idle during the reflog event and the debounce window.

## 2026-10-17 — A before/after `git status` diff does not say who made the change
The diff contains every path that changed during the window in which the command ran, including untracked files created, and clean tracked files edited, by an editor, a build watcher, or another tool at the same time. Committing the whole diff puts someone else's work into the update commit, and reverting the diff with `git checkout` on failure deletes that work. So the commit and revert scope is limited to the files the command is expected to produce (`commitPaths`: lock files, manifests), and everything else is only reported.

## 2026-10-28 — npm trusted publishing needs npm >= 11.5.1 and an existing package
Trusted publishing (OIDC) requires npm CLI 11.5.1+ and Node 22.14+, while the npm bundled with Node 22 is 10.x, so the `publish` job upgrades npm first. A trusted publisher can only be configured in the settings of a package that already exists on npm, so the very first version has to be published by hand; CI takes over from the next version on. A new trusted publisher expires if it doesn't complete a publish within 2 days, so it is added right before the first version bump CI should publish, not right after the manual publish.

## 2026-10-28 — `process.execPath` is symlink-resolved, so it must not be written into launchers
Under Homebrew it is `/opt/homebrew/Cellar/node/<version>/bin/node` rather than `/opt/homebrew/bin/node`, and under nvm it is a version-specific path. A launchd agent or menubar plugin that pins it breaks on the next `brew upgrade node` or when that version is removed. launchd runs jobs with a minimal PATH, so the launchers run `node` through an explicit saved PATH instead (`/usr/bin/env node` in the plist).

## 2026-10-28 — Windows has no catchable SIGTERM, and Task Scheduler does not restart a crashed task
`process.kill(pid, 'SIGTERM')` on Windows is `TerminateProcess`: the daemon's shutdown handler never runs, so the in-flight command is not rolled back and locks stay behind. A supervised daemon is therefore stopped through its control channel (named pipe). Task Scheduler's "restart on failure" only covers a task that fails to start, not a process that exits non-zero, and `conhost --headless` (to hide a console window) is undocumented and unreliable, so Windows uses a Startup-folder script that starts a Node supervisor detached with `windowsHide`.

## 2026-10-28 — A Unix socket path is limited to about 104 bytes on macOS
Under a temp `XDG_STATE_HOME` (`/private/var/folders/.../T/...`) the state directory alone gets close to it, and `listen()` fails with a too-long path. The control socket falls back to a hashed name in the temp directory when the state-directory path is too long.

## 2026-10-28 — npm runs scripts through cmd.exe on Windows, which does not strip single quotes
`node --test 'test/*.test.js'` passes the quotes through on Windows, so the glob matches nothing. Double quotes work in both `sh` and `cmd.exe`.

## 2026-10-28 — On Windows `fs.realpathSync` keeps 8.3 short names, git does not
`os.tmpdir()` on a GitHub Windows runner is `C:\Users\RUNNER~1\...`; `fs.realpathSync` keeps the short name while `git rev-parse --show-toplevel` and `fs.realpathSync.native` return `C:\Users\runneradmin\...`, so one repo showed up under two paths. Paths that are compared with git's use `fs.realpathSync.native` on Windows.
