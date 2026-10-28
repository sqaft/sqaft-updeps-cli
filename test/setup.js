// Preloaded into every test process (`node --test --import ./test/setup.js`, see
// the "test" script in package.json). Points XDG_CONFIG_HOME / XDG_STATE_HOME /
// XDG_DATA_HOME at a fresh temp directory before any src module is imported, so
// src/paths.js can never resolve to the developer's real ~/.config/sqaft-updeps,
// ~/.local/state/sqaft-updeps (config, state, journal, locks, log file) or
// ~/.local/share/sqaft-updeps (the desktop app).
// Test files that need a directory of their own can still assign these
// variables themselves before importing src modules; this is the safety net for
// all the others.
//
// It also turns off git's line-ending conversion for the throwaway repos the
// tests create (Git for Windows enables `core.autocrlf` system-wide), so file
// contents read back from the working tree match what the tests wrote.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'updeps-xdg-')));
process.env.XDG_CONFIG_HOME = path.join(root, 'config');
process.env.XDG_STATE_HOME = path.join(root, 'state');
process.env.XDG_DATA_HOME = path.join(root, 'data');
delete process.env.UPDEPS_APP;

const gitConfigCount = parseInt(process.env.GIT_CONFIG_COUNT || '0', 10) || 0;
process.env[`GIT_CONFIG_KEY_${gitConfigCount}`] = 'core.autocrlf';
process.env[`GIT_CONFIG_VALUE_${gitConfigCount}`] = 'false';
process.env.GIT_CONFIG_COUNT = String(gitConfigCount + 1);

process.on('exit', () => {
  fs.rmSync(root, { recursive: true, force: true });
});
