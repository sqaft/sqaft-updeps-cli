// Preloaded into every test process (`node --test --import ./test/setup.js`, see
// the "test" script in package.json). Points XDG_CONFIG_HOME / XDG_STATE_HOME at
// a fresh temp directory before any src module is imported, so src/paths.js can
// never resolve to the developer's real ~/.config/sqaft-updeps or
// ~/.local/state/sqaft-updeps (config, state, journal, locks, log file).
// Test files that need a directory of their own can still assign these
// variables themselves before importing src modules; this is the safety net for
// all the others.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'updeps-xdg-')));
process.env.XDG_CONFIG_HOME = path.join(root, 'config');
process.env.XDG_STATE_HOME = path.join(root, 'state');

process.on('exit', () => {
  fs.rmSync(root, { recursive: true, force: true });
});
