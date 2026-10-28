# @sqaft/updeps-cli

A language- and package-manager-agnostic macOS CLI and background service. When a
package is `git push`ed, it goes to the other repos that depend on it, runs the
commands you define, and commits the changed lock files.

Nothing is added to managed repos: no git hooks, no config file, no dependency.
All definitions live in a single central file; the tool knows about your repos,
and the repos know nothing about the tool.

---

## How it works

1. A daemon watches only the relevant git reflog files of the source repos you
   define (`.git/logs/refs/remotes/origin/<branch>`, no polling, FSEvents).
2. When you push to a source repo, git updates this file with an
   `update by push` message and the daemon picks up the event. (If the push
   fails, the file is not updated and nothing happens, so no extra verification
   is needed.) Pushes made while the daemon is down (restart, crash,
   `updeps stop`) are not lost: the last seen tip of each reflog file is kept in
   `state.json`, compared with the current tip on `updeps start`, and any
   difference enters the normal flow exactly like a live event.
3. After a short `debounceMs` window, for **every target repo** that depends on
   that source, one at a time (a single job at a time across the whole system):
   - the target repo is locked (`mkdir`-based, since macOS has no `flock`),
   - the `commands` are run,
   - of the files that changed during the commands, **only those matching
     `commitPaths`** (default: lock files and manifests) are committed; your
     uncommitted work is left alone, and changes outside the list (e.g. files
     touched by another process while the commands ran) are left in place and
     reported as warnings,
   - if `push: true`, the commit is pushed (default: no).
4. One macOS notification per source: `3 committed, 2 up to date, 0 failed`.

---

## Installation

```bash
npm install -g @sqaft/updeps-cli
```

Requires macOS and Node.js 22+. This installs the `updeps` and `sqaft-updeps`
commands.

---

## Quick start

```bash
updeps init                 # creates ~/.config/sqaft-updeps/config.json
# (edit the config)
updeps doctor               # check paths, git remotes, and commands
updeps graph                # see the dependency tree and the derived {pkgs} lists
updeps run <source> --dry-run   # try it without committing
updeps start                # start the launchd daemon
updeps status               # state, running job + queue, open failures
```

---

## Configuration

Location: `~/.config/sqaft-updeps/config.json` (honors `XDG_CONFIG_HOME`).

If you edit this file while the daemon is running, the change is **detected and
reloaded automatically**; no `updeps restart` is needed. (On invalid JSON or a
validation error, the previous settings are kept and the error is written to the
log.) Changes made with `updeps init`, `updeps add`, and `updeps remove` are
applied live the same way.

An unknown field name (a typo such as `comands`) does not invalidate the config.
Instead of being silently ignored and falling back to the default, it shows up as
a warning in the `updeps doctor` output and in the daemon log.

```jsonc
{
  "notifications": true,
  "defaults": {
    "triggers": ["push"],                 // push | fetch | commit | merge
    "branches": [],                       // empty = the source's default branch (origin/HEAD)
    "commands": ["npm update {pkgs} --no-audit --no-fund"],
    "commitMessage": "chore(deps): bump {bumps}",
    "commandTimeout": 300,                // seconds
    "debounceMs": 3000,
    "staleLockSec": 900,                  // locks older than this are considered "stale"
    "waitTimeoutSec": 0,                  // 0 = wait for the lock indefinitely
    "dirtyPolicy": "selective",           // selective | skip
    // "commitPaths": [...]               // files to commit (globs); see "commitPaths" for the default
    "push": false,
    "coalesce": true,                     // see "Concurrency"
    "squash": true                        // see "Squashing previous update commits"
  },
  "repos": [
    {
      "path": "~/workspace/acme/acme-api",
      "name": "@acme/api",                // dependency name in the package manager ({pkg}/{pkgs})
      "branches": ["main"],               // optional, per source
      "packages": [
        {
          "path": "~/workspace/acme/acme-worker",
          "name": "acme-worker",          // label only (log/notification); defaults to the folder name
          "commands": ["yarn upgrade {pkgs}"],
          "commitMessage": "deps: {bumps}",
          "push": false,
          "squash": true,
          "commandTimeout": 300,
          "dirtyPolicy": "selective",
          "commitPaths": ["package.json", "yarn.lock"]  // replaces the default list
        }
      ]
    }
  ]
}
```

For a multi-organization example, see [`examples/config.json`](examples/config.json)
(`updeps init --example` writes it).

### The two meanings of `name`

- **`repos[].name`**: the dependency identifier in the package manager. `{pkg}`
  and `{pkgs}` are filled from it. Defaults to the folder name.
- **`repos[].packages[].name`**: a human-readable label only (log, notification,
  CLI output). Defaults to the folder name.

### How `{pkgs}` is derived

For a target repo, `{pkgs}` is the names of **all the sources that list that
target as a dependent** (in config order). For example, in `examples/config.json`
`umbrella-machine` is linked to four separate sources; whichever one is pushed,
the command is:

```
yarn upgrade @umbrella/api @umbrella/mobile-client @umbrella/web-client @umbrella/realtime
```

This way nested/transitive copies are updated in a single call and the SHAs stay
consistent across repos, without having to parse lock files.

### Template variables

In `commands` and `commitMessage`:

| Variable | Content |
|---|---|
| `{pkg}` | Name of the triggering source |
| `{pkgs}` | The derived package list (shell-quoted in commands, comma-separated in the commit message) |
| `{sha}` | 7-character SHA of the triggering commit |
| `{bumps}` | `{pkg}@{sha}`; if several sources were coalesced into the same target, `a@sha1, b@sha2` |
| `{sourcePath}` · `{sourceBranch}` | Source repo path / branch |
| `{targetPath}` · `{targetBranch}` | Target repo path / active branch |

### `dirtyPolicy`

- **`selective`** (default): runs even if the target repo has uncommitted
  changes; `git status` is diffed before and after the commands, and of the
  files in the diff **only those matching [`commitPaths`](#commitpaths)** are
  staged and committed. Your uncommitted work is left alone; `git add -A` is
  never used.
- **`skip`**: if the target working tree is dirty, don't touch it at all and
  report it as skipped.

While the commands run, another process (an editor, a build watcher, another
tool) may also create or edit files in the repo, and the `git status` diff cannot
tell that apart from what the commands did. So files in the diff that are outside
`commitPaths` (tracked or untracked) are neither committed nor reverted: they are
left in place and written as warnings to the log and to the run result
(`updeps show`, `updeps history`, and `otherFiles` / `warnings` in the journal).

If a command fails, only tracked files that **were clean before the command**,
changed during it, and match `commitPaths` are reverted; other changes are left
alone and untracked files are not deleted. `--dry-run` reverts with the same rule
instead of committing. `git reset --hard` / `git clean -fd` are never run under
any circumstances.

### `commitPaths`

A glob list of the files that may be committed in a target. It can be set in
`defaults` or per target; a target-level list replaces the default (they are not
merged). The default is the lock files and manifests of common package managers
(at any depth):

```
package.json  package-lock.json  npm-shrinkwrap.json  yarn.lock  pnpm-lock.yaml
bun.lock  bun.lockb  composer.json  composer.lock  Cargo.toml  Cargo.lock
go.mod  go.sum  Gemfile.lock  poetry.lock  uv.lock  Package.resolved  pubspec.lock
```

If a path that changed during the commands matches a pattern in the list, it is
committed; newly created (untracked) files are also committed only if they match.
Patterns are matched against paths relative to the repo root:

| Pattern | Meaning |
|---|---|
| `yarn.lock` | A pattern without `/` matches the file name at any depth (`yarn.lock`, `packages/web/yarn.lock`) |
| `/package.json`, `apps/*/package.json` | A pattern that starts with `/` or contains `/` is anchored to the repo root |
| `*`, `?` | Any sequence of characters other than `/` / a single character |
| `gen/**/*.json` | `**` as a whole path segment matches zero or more directories |
| `generated/` | A pattern ending in `/` matches everything under that directory |
| `{go.mod,go.sum}` | One of the alternatives (cannot be nested) |

Negation with `!` is not supported. An empty list and an empty or invalid pattern
(such as an unclosed `{`) are rejected during config validation. If you want
every file the commands produce to be committed, you can use `["**"]`; in that
case changes made by other processes while the commands ran are committed too.

### Squashing previous update commits (`squash`)

If the target repo has commits that updeps made earlier and that have **not been
pushed yet** (because the same target was updated several times), the new update
commit is combined with them into a single commit; a separate commit does not
pile up for every update. The commit message lists all the combined sources with
`{bumps}` (a source that was updated more than once appears with its latest SHA).

The rules are strict to rule out mistakes:

- Only commits that updeps itself recorded (`state.json` → `autoCommits`, exact
  full-SHA match) are squashed. No commit that merely looks similar, or that you
  made, is ever squashed; if you `--amend`/rebase an updeps commit it is no
  longer recognized.
- The chain starts right below the new commit and ends at the first commit that
  does not belong to updeps: if one of your commits is in between, everything
  below it is left alone.
- A pushed commit (one reachable from any remote-tracking ref) is not squashed;
  if another local branch or tag contains the same commit, if there is a merge
  commit, if HEAD is detached, or if `commit.gpgsign` is on, no squashing takes
  place and the update stays a separate commit.
- Squashing only moves the branch reference; the index and the working tree are
  not touched, and the resulting commit's tree is identical to the update
  commit's, so file contents cannot change. The ref update is a
  compare-and-swap (CAS): if another commit lands in between, nothing happens.
  The squashed commits stay in the reflog and are visible with `updeps show`.
- On any error or uncertainty the update stays a separate commit; squashing never
  fails a run.

To turn it off, set `"squash": false` (in `defaults` or per target).

### `push: true` and cascading

With `push: true`, the commit made in the target is pushed, which in turn triggers
other repos that list that target as a source (a cascade). This is usually
unwanted, so the default is `false`. `updeps graph` and `updeps doctor` warn
about dependency cycles. To run the chain yourself, in a controlled way, use
`updeps push` (below).

---

## Cascade push (`updeps push`)

When unpushed commits have accumulated in several repos, pushing them in an
arbitrary order causes the same target to be updated more than once: in an
`A → B → C` chain, if B is pushed before it has received A's update, C is
updated twice. `updeps push` reduces this to a single update:

```bash
cd ~/workspace/acme       # in a repo, in a directory that holds repos, or both (a workspace repo)
updeps push --dry-run     # scope + estimated rounds, pushes nothing
updeps push
updeps push --commit="wip: bulk changes"   # first commit the repos that have changes
```

The scope is the union of two parts, either of which may be empty:

- if the current directory is inside a repo (the repo root or any subdirectory),
  that repo,
- the git repos **one level** below the current directory (except `node_modules`,
  `vendor`, and directories starting with `.`; it does not go deeper).

So when run at the root of a workspace repo that holds project repos in its
subdirectories, the workspace repo and all the project repos are pushed together;
in a directory that is not a repo, only the repos immediately below it; in a
single project repo, only that repo. Repos that are not in the config are pushed
too; the order is derived from the source → target relationships in the config.
Repos with no upstream or with a detached HEAD are skipped.

Each round:

1. Among the repos with unpushed commits, those none of whose (transitive)
   sources are among the repos waiting to be pushed are pushed. In the example
   above, if A, B, and C all have commits, only A is pushed first.
2. It waits for the daemon to process these pushes: until the `origin` tip of the
   relevant sources matches `lastProcessedSha` in `state.json`, and there is no
   running job or queue left. The daemon's own `push: true` pushes are awaited
   too.
3. The update commits made by the daemon show up as new unpushed commits; B is
   now pushed in one go with both its own commit and the update that came from A.
   This repeats until there are no commits left to push.

`--commit="message"`: after the daemon has gone idle and before the first push,
in every pushable repo in scope (one that has an upstream and is not in a
detached HEAD or in the middle of a merge/rebase), all pending changes (tracked,
deleted, and untracked files; `.gitignore` applies) are put into a single commit
with `git add -A` + `git commit -m "message"`. The repo's own hooks run; if a
commit cannot be made in any repo (a hook failure, an unresolved conflict, etc.),
it stops without pushing anything. The commits take part in the push order like
ordinary commits, so a new source commit updates the dependent repos in the same
rounds. With `--dry-run` it shows how many files would be committed in which
repos. These commits are yours: they never take part in updeps' `squash`
merging.

The daemon must be running before you start (`updeps start`). If a push fails, if
the daemon cannot update a target (`failed`), or if the daemon does not process a
push, the command stops and exits with `1`; once you fix the problem and run it
again, it continues where it left off. No `fetch`/`pull`/rebase is ever done: if
the remote is ahead, the push is rejected and the command stops.

---

## Commands

| Command | What it does |
|---|---|
| `updeps init [--force] [--example]` | Creates a sample configuration |
| `updeps list` | Lists the source repos and their targets |
| `updeps graph` | ASCII dependency tree + cycle check + derived `{pkgs}` lists |
| `updeps add <source> --target <target> [--name N] [--target-name N] [--command "..."]` | Adds a relationship to the config |
| `updeps remove <source> [target]` | Removes a relationship or a source |
| `updeps run [source] [--target X] [--dry-run]` | Manual run (skips trigger/branch filters) |
| `updeps retry --failed` \| `updeps retry <target>` | Retries open failures |
| `updeps push [--dry-run] [--commit=MSG]` | Pushes the unpushed commits in the current directory (the repo you are in and the repos one level below) in dependency order, waiting for the daemon's updates after each round. See "Cascade push" |
| `updeps status [-w/--watch]` | What is running right now + queued targets, **open failures**, recent runs. `--watch` = a live view refreshed every second |
| `updeps history [--failed] [--repo X] [--since 2d] [-n N] [--json]` | The full operation history (from the persistent JSONL journal) |
| `updeps show <group-id \| target \| source>` | Full detail of a run: commands, output, commit SHA, error output |
| `updeps logs [-f] [-n N]` | Raw log |
| `updeps doctor` | System health check |
| `updeps start` · `stop` · `restart` | launchd daemon control |
| `updeps menubar [--install]` | SwiftBar / xbar menu bar plugin |
| `updeps reset [--yes] [--keep-daemon]` | Deletes all data **except** the config: queue, open failures, history (journal), raw logs, processed-SHA tracking, locks. If the daemon is running it is restarted to also clear the in-memory queue (skipped with `--keep-daemon`). `--yes` skips the confirmation. The **Maintenance › Clear data** button in the menu bar does the same. |

---

## Concurrency

**A single job runs at a time** across the whole system (a global serial queue).
Consecutive pushes to a source merge within `debounceMs`. If the queue holds a job
for the same target that has not started yet, and that target's `coalesce`
setting is on (default `true`), the new trigger is added to it (no separate job
is created); since `{pkgs}` already covers all the sources, a second run would
usually be a no-op. In the merged job `{bumps}` lists each source separately
(`a@sha1, b@sha2`). With `coalesce: false`, the target is run separately for each
source that accumulated in the same debounce window. When two sources define
**different** commands/branches/etc. for the same target (e.g. one has
`branches: ["main"]` and the other a different `commands` list), merging never
happens: each one runs as a separate job with its own settings, so one source's
settings never leak into the other. If a new event arrives for a target that is
currently running, it is queued again after the job finishes.

---

## Monitoring and failure tracking

Every operation is written persistently to
`~/.local/state/sqaft-updeps/journal.jsonl` as a single line of JSON (rotated to
`.1` at 5MB). You can see it in three places:

- **`updeps status`**: what is running right now + queued targets, **unresolved
  open failures**, the last 10 runs. With `--watch` you can leave the terminal
  window open and follow it live.
- **`updeps history --failed --since 3d`**: filtered history; pipe it with
  `--json`.
- **`updeps show <target>`**: a single run's commands, output, and commit.

Open failures are kept persistently in `state.json`; when that target next runs
successfully or with no changes (from the daemon or via `updeps retry --failed`),
the failure is cleared automatically. The menu bar shows `⚠N` (failures) and `⧗N`
(running + queued jobs) badges and a clickable list of failures.

## File locations

```
~/.config/sqaft-updeps/config.json                    definitions (you edit this)
~/.local/state/sqaft-updeps/state.json                runtime state, open failures
~/.local/state/sqaft-updeps/journal.jsonl             persistent operation journal
~/.local/state/sqaft-updeps/locks/                    target repo locks
~/.local/state/sqaft-updeps/logs/updeps.log           raw log (rotated at 5MB)
~/Library/LaunchAgents/com.sqaft.updeps.daemon.plist  launchd agent
```

If `XDG_CONFIG_HOME` / `XDG_STATE_HOME` are set, they are honored.

### Node version managers and reinstalls

The launchd agent (`~/Library/LaunchAgents/com.sqaft.updeps.daemon.plist`) and the
SwiftBar/xbar plugin run `node` through the PATH saved at `updeps start` and
`updeps menubar --install` (your PATH at that moment, plus the directory of the
Node running the CLI). They do not pin a Node binary, so Homebrew upgrades and
switching between installed Node versions keep working.

It still breaks when no supported Node (see `engines` in `package.json`) remains on
that PATH, or when the package itself was installed inside a Node version that has
been removed (nvm keeps global packages per version). Reinstall the package, then
run `updeps restart` (and `updeps menubar --install` for the plugin). After
switching versions, `updeps restart` also refreshes the saved PATH.
`updeps doctor` and `updeps status` report a missing or too old Node and a missing
CLI, and the menu bar shows it too.

After upgrading the package, the running daemon is still on the old code until it
is restarted. `updeps status` (and `updeps doctor`) warn when the installed code
files are newer than the running daemon; run `updeps restart` to load the new
code.

---

## Security

The commands in the config run through the shell with your user's permissions, so
treat the config file as trusted code: anyone who can edit it can run commands as
you. updeps adds nothing to the repos it manages.

**Secret redaction:** git remote tokens, GitHub PATs, `Authorization` headers,
etc. in command output are masked with `***` before being written to the log, the
journal, and notifications (`src/redact.js`).

---

## Development

```bash
git clone https://github.com/sqaft/sqaft-updeps-cli
cd sqaft-updeps-cli
npm install
npm link            # installs the updeps and sqaft-updeps commands
npm test            # node:test, no extra dependencies
```

Publishing happens from CI: when the `version` in `package.json` is not on npm yet,
the `publish` job in `.github/workflows/test.yml` publishes it after the tests pass.

---

## Notes

- If a command changes a `.gitignore`d file (such as `node_modules/`), it does
  not show up in `git status`; this is intended. If the command changes no file
  that matches `commitPaths`, the result is "up to date" (`unchanged`); if there
  are non-matching changes, they appear as a warning.

---

## License

MIT — see [LICENSE](LICENSE).
