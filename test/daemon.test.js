import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers.js';

const { dir, cleanup } = tmpDir('updeps-daemon-');
process.env.XDG_STATE_HOME = dir;
process.env.XDG_CONFIG_HOME = dir;

const { inspectLauncher, launchPath, findInPath, minNodeMajor, BIN_PATH } = await import('../src/launcher.js');
const { renderPlist, inspect: inspectAgentPlist } = await import('../src/service/launchd.js');
const { parsePluginScript, inspectMenubarPlugin } = await import('../src/commands/menubar.js');

test.after(cleanup);

const isWindows = process.platform === 'win32';
const D = path.delimiter;
/** Tests that run the fake `node` shell scripts below. */
const posixTest = (name, fn) => test(name, { skip: isWindows && 'fake node scripts need a POSIX shell' }, fn);
const hasPlutil = spawnSync('plutil', ['-help'], { stdio: 'ignore' }).error === undefined;
const plistTest = (name, fn) => test(name, { skip: !hasPlutil && 'plutil not available' }, fn);

/** A directory holding a fake `node` that prints the given version. */
function fakeNodeDir(name, version) {
  const nodeDir = path.join(dir, name);
  fs.mkdirSync(nodeDir, { recursive: true });
  const file = path.join(nodeDir, 'node');
  fs.writeFileSync(file, `#!/bin/sh\necho ${version}\n`);
  fs.chmodSync(file, 0o755);
  return nodeDir;
}

const goodNodeDir = fakeNodeDir('node-good', 'v22.3.0');
const oldNodeDir = fakeNodeDir('node-old', 'v18.0.0');
const emptyDir = path.join(dir, 'no-node');
fs.mkdirSync(emptyDir);

/** Writes a plist; `args` are the ProgramArguments, `pathEnv` the EnvironmentVariables.PATH (if any). */
function writePlist(name, args, pathEnv) {
  const file = path.join(dir, name);
  const env = pathEnv === undefined ? '' : `<key>EnvironmentVariables</key><dict><key>PATH</key><string>${pathEnv}</string></dict>`;
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>test.agent</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  ${env}
</dict>
</plist>
`
  );
  return file;
}

const envPlist = (name, pathEnv, bin = BIN_PATH) =>
  writePlist(name, ['/usr/bin/env', 'node', bin, 'daemon'], pathEnv);

// A real file that is not this install's CLI entry point.
const otherFile = path.join(dir, 'other-file');
fs.writeFileSync(otherFile, '');

test('minNodeMajor: reads engines.node from package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(minNodeMajor(), parseInt(/\d+/.exec(pkg.engines.node)[0], 10));
  assert.ok(minNodeMajor() > 18);
});

test('launchPath: dedupes, keeps order and appends the Node directory', () => {
  const join = (...entries) => entries.join(D);
  assert.equal(launchPath(join('/a', '/b', '/a', '', '/c'), '/node/bin'), join('/a', '/b', '/c', '/node/bin'));
  assert.equal(launchPath(join('/a', '/node/bin', '/b'), '/node/bin'), join('/a', '/node/bin', '/b'));
  assert.equal(launchPath('', '/node/bin'), '/node/bin');
  assert.equal(launchPath(null, '/node/bin'), '/node/bin');
});

posixTest('findInPath: first executable in PATH order', () => {
  assert.equal(findInPath('node', `${emptyDir}:${goodNodeDir}:${oldNodeDir}`), path.join(goodNodeDir, 'node'));
  assert.equal(findInPath('node', `${oldNodeDir}:${goodNodeDir}`), path.join(oldNodeDir, 'node'));
  assert.equal(findInPath('node', `${emptyDir}:`), null);
  const plain = path.join(dir, 'not-executable');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'node'), '');
  assert.equal(findInPath('node', `${plain}:${goodNodeDir}`), path.join(goodNodeDir, 'node'));
});

test('findInPath: on Windows a bare name is tried with the PATHEXT extensions', { skip: !isWindows && 'Windows only' }, () => {
  const exeDir = path.join(dir, 'win-node');
  fs.mkdirSync(exeDir);
  fs.writeFileSync(path.join(exeDir, 'node.exe'), '');
  assert.equal(findInPath('node', `${emptyDir}${D}${exeDir}`).toLowerCase(), path.join(exeDir, 'node.exe').toLowerCase());
});

plistTest('inspectAgentPlist: no plist means not installed', () => {
  const res = inspectAgentPlist(path.join(dir, 'missing.plist'));
  assert.deepEqual(res, {
    installed: false,
    node: null,
    nodeVersion: null,
    bin: null,
    problem: null,
    error: null
  });
});

plistTest('inspectAgentPlist: env-style plist resolves node from its PATH', () => {
  const res = inspectAgentPlist(envPlist('env-ok.plist', `${emptyDir}:${goodNodeDir}:${oldNodeDir}`));
  assert.equal(res.installed, true);
  assert.equal(res.node, path.join(goodNodeDir, 'node'));
  assert.equal(res.nodeVersion, 'v22.3.0');
  assert.equal(res.bin, BIN_PATH);
  assert.equal(res.problem, null);
  assert.equal(res.error, null);
});

plistTest('inspectAgentPlist: node missing from the PATH', () => {
  const res = inspectAgentPlist(envPlist('env-nonode.plist', emptyDir));
  assert.equal(res.problem, 'node-missing');
  assert.equal(res.node, null);
  assert.equal(inspectAgentPlist(envPlist('env-nopath.plist', undefined)).problem, 'node-missing');
});

plistTest('inspectAgentPlist: node too old', () => {
  const res = inspectAgentPlist(envPlist('env-old.plist', `${oldNodeDir}:${goodNodeDir}`));
  assert.equal(res.problem, 'node-too-old');
  assert.equal(res.node, path.join(oldNodeDir, 'node'));
  assert.equal(res.nodeVersion, 'v18.0.0');
});

plistTest('inspectAgentPlist: missing CLI entry point', () => {
  const res = inspectAgentPlist(envPlist('env-bin.plist', goodNodeDir, path.join(dir, 'gone', 'updeps.js')));
  assert.equal(res.problem, 'bin-missing');
});

plistTest('inspectAgentPlist: CLI of a different install', () => {
  assert.equal(inspectAgentPlist(envPlist('env-other.plist', goodNodeDir, otherFile)).problem, 'different-install');
});

plistTest('inspectAgentPlist: symlink to this CLI has no problem', () => {
  const binLink = path.join(dir, 'bin-link');
  fs.symlinkSync(BIN_PATH, binLink);
  assert.equal(inspectAgentPlist(envPlist('env-link.plist', goodNodeDir, binLink)).problem, null);
});

plistTest('inspectAgentPlist: legacy plist with an absolute Node path', () => {
  const nodeBin = path.join(goodNodeDir, 'node');
  const ok = inspectAgentPlist(writePlist('legacy-ok.plist', [nodeBin, BIN_PATH, 'daemon'], emptyDir));
  assert.equal(ok.node, nodeBin);
  assert.equal(ok.nodeVersion, 'v22.3.0');
  assert.equal(ok.bin, BIN_PATH);
  assert.equal(ok.problem, null);

  const gone = inspectAgentPlist(writePlist('legacy-gone.plist', [path.join(dir, 'gone', 'node'), BIN_PATH, 'daemon']));
  assert.equal(gone.problem, 'node-missing');
  assert.equal(gone.node, path.join(dir, 'gone', 'node'));

  const old = inspectAgentPlist(writePlist('legacy-old.plist', [path.join(oldNodeDir, 'node'), BIN_PATH, 'daemon']));
  assert.equal(old.problem, 'node-too-old');

  const bin = inspectAgentPlist(writePlist('legacy-bin.plist', [nodeBin, path.join(dir, 'gone', 'updeps.js'), 'daemon']));
  assert.equal(bin.problem, 'bin-missing');

  const other = inspectAgentPlist(writePlist('legacy-other.plist', [nodeBin, otherFile, 'daemon']));
  assert.equal(other.problem, 'different-install');
});

plistTest('inspectAgentPlist: unreadable plist reports an error and no problem', () => {
  const file = path.join(dir, 'broken.plist');
  fs.writeFileSync(file, 'not a plist');
  const res = inspectAgentPlist(file);
  assert.equal(res.installed, true);
  assert.equal(res.problem, null);
  assert.ok(res.error);
});

plistTest('renderPlist: runs node through env with the launch PATH, XML-escaped', () => {
  const nodeDir = fakeNodeDir('node & co <v22>', 'v22.3.0');
  const savedPath = process.env.PATH;
  process.env.PATH = `${nodeDir}:${savedPath}`;
  try {
    const xml = renderPlist();
    assert.match(xml, /<string>\/usr\/bin\/env<\/string>\s*<string>node<\/string>\s*<string>[^<]*updeps\.js<\/string>\s*<string>daemon<\/string>/);
    assert.ok(xml.includes('node &amp; co &lt;v22&gt;'));
    assert.ok(!xml.includes('node & co'));

    const file = path.join(dir, 'rendered.plist');
    fs.writeFileSync(file, xml);
    const res = inspectAgentPlist(file);
    assert.equal(res.error, null);
    assert.equal(res.node, path.join(nodeDir, 'node'));
    assert.equal(res.nodeVersion, 'v22.3.0');
    assert.equal(res.bin, BIN_PATH);
    assert.equal(res.problem, null);
  } finally {
    process.env.PATH = savedPath;
  }
});

posixTest('inspectLauncher: pinned and PATH-resolved Node', () => {
  assert.equal(inspectLauncher({ node: null, bin: BIN_PATH }).problem, 'node-missing');
  assert.equal(inspectLauncher({ node: 'node', bin: BIN_PATH, pathEnv: emptyDir }).problem, 'node-missing');
  assert.equal(inspectLauncher({ node: 'node', bin: null, pathEnv: goodNodeDir }).problem, 'bin-missing');
  assert.equal(inspectLauncher({ node: 'node', bin: BIN_PATH, pathEnv: goodNodeDir }).problem, null);
  // a different Node than the one running the CLI is fine
  const res = inspectLauncher({ node: path.join(goodNodeDir, 'node'), bin: BIN_PATH });
  assert.equal(res.problem, null);
  assert.notEqual(res.node, process.execPath);
});

test('parsePluginScript: PATH-based form', () => {
  const script = `#!/usr/bin/env bash
# <xbar.title>updeps</xbar.title>
export PATH="/opt/homebrew/bin:/Users/me/Library/Application Support/x:/a\\"b\\$c"
exec node "/Users/me/lib/updeps/bin/updeps.js" menubar
`;
  assert.deepEqual(parsePluginScript(script), {
    node: 'node',
    bin: '/Users/me/lib/updeps/bin/updeps.js',
    path: '/opt/homebrew/bin:/Users/me/Library/Application Support/x:/a"b$c'
  });
});

test('parsePluginScript: older absolute-path form', () => {
  const script = `#!/usr/bin/env bash
exec "/Users/me/.nvm/versions/node/v22.19.0/bin/node" "/Users/me/lib/updeps/bin/updeps.js" menubar
`;
  assert.deepEqual(parsePluginScript(script), {
    node: '/Users/me/.nvm/versions/node/v22.19.0/bin/node',
    bin: '/Users/me/lib/updeps/bin/updeps.js',
    path: null
  });
});

test('parsePluginScript: returns null without an exec line', () => {
  assert.equal(parsePluginScript('#!/usr/bin/env bash\necho hi\n'), null);
  assert.equal(parsePluginScript(''), null);
});

test('inspectMenubarPlugin: not installed', () => {
  const empty = path.join(dir, 'plugins-empty');
  fs.mkdirSync(empty);
  assert.equal(inspectMenubarPlugin(empty).installed, false);
  assert.equal(inspectMenubarPlugin(path.join(dir, 'no-such-dir')).installed, false);
});

posixTest('inspectMenubarPlugin: PATH-based and older forms', () => {
  const plugins = path.join(dir, 'plugins');
  fs.mkdirSync(plugins);
  const pluginPath = path.join(plugins, 'updeps.30s.sh');
  const write = (body) => fs.writeFileSync(pluginPath, `#!/usr/bin/env bash\n${body}\n`);
  const envForm = (pathEnv, bin = BIN_PATH) => write(`export PATH="${pathEnv}"\nexec node "${bin}" menubar`);

  envForm(`${emptyDir}:${goodNodeDir}`);
  let res = inspectMenubarPlugin(plugins);
  assert.equal(res.installed, true);
  assert.equal(res.path, pluginPath);
  assert.equal(res.node, path.join(goodNodeDir, 'node'));
  assert.equal(res.nodeVersion, 'v22.3.0');
  assert.equal(res.problem, null);

  envForm(emptyDir);
  assert.equal(inspectMenubarPlugin(plugins).problem, 'node-missing');

  envForm(oldNodeDir);
  assert.equal(inspectMenubarPlugin(plugins).problem, 'node-too-old');

  envForm(goodNodeDir, path.join(dir, 'gone', 'updeps.js'));
  assert.equal(inspectMenubarPlugin(plugins).problem, 'bin-missing');

  envForm(goodNodeDir, otherFile);
  assert.equal(inspectMenubarPlugin(plugins).problem, 'different-install');

  write(`exec "${path.join(goodNodeDir, 'node')}" "${BIN_PATH}" menubar`);
  res = inspectMenubarPlugin(plugins);
  assert.equal(res.node, path.join(goodNodeDir, 'node'));
  assert.equal(res.problem, null);

  write(`exec "${path.join(dir, 'gone', 'node')}" "${BIN_PATH}" menubar`);
  assert.equal(inspectMenubarPlugin(plugins).problem, 'node-missing');

  write('echo hi');
  res = inspectMenubarPlugin(plugins);
  assert.equal(res.installed, true);
  assert.equal(res.node, null);
  assert.equal(res.problem, null);
});
