import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir, initGitRepo } from './helpers.js';

const { dir, cleanup } = tmpDir('updeps-squash-');
process.env.XDG_STATE_HOME = path.join(dir, 'state');
process.env.XDG_CONFIG_HOME = path.join(dir, 'config');

const { squashableChain, squashOnto } = await import('../src/gitops.js');
const { runTarget } = await import('../src/runner.js');
const { resolveConfig } = await import('../src/config.js');
const { loadState } = await import('../src/state.js');

test.after(cleanup);

function g(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

let seq = 0;
/** Repo with one pushed commit (bare remote `origin`) and a bump script that appends a line to deps.lock. */
function makeTarget(extraConfig = {}) {
  const base = path.join(dir, `t${++seq}`);
  const remote = path.join(base, 'remote.git');
  const work = path.join(base, 'work');
  fs.mkdirSync(remote, { recursive: true });
  g(['init', '-q', '--bare', '-b', 'main'], remote);
  initGitRepo(work);
  fs.writeFileSync(path.join(work, 'deps.lock'), '');
  fs.writeFileSync(path.join(work, 'bump.sh'), 'echo "$1 $RANDOM$RANDOM" >> deps.lock\n');
  g(['add', '-A'], work);
  g(['commit', '-qm', 'base'], work);
  g(['remote', 'add', 'origin', remote], work);
  g(['push', '-q', '-u', 'origin', 'main'], work);
  const baseSha = g(['rev-parse', 'HEAD'], work);

  const config = resolveConfig({
    notifications: false,
    defaults: { commandTimeout: 30, commands: ['bash bump.sh {pkg}'] },
    repos: [{ path: work, name: 'src', packages: [{ path: work, name: 'tgt', ...extraConfig }] }]
  });
  return { work, baseSha, config, target: config.repos[0].packages[0] };
}

let shaSeq = 0;
function bump({ config, target, work }, source = 'a') {
  const sha = String(++shaSeq).padEnd(40, '0');
  return runTarget({
    config,
    target,
    trigger: { trigger: 'manual', sourceName: source, sourcePath: work, sha }
  });
}

const subjects = (work) => g(['log', '--format=%s'], work).split('\n');
/** Commits above the pushed base commit. */
const count = (t, ref = 'HEAD') => Number(g(['rev-list', '--count', `${t.baseSha}..${ref}`], t.work));

test('ardışık updeps commit\'leri tek commit\'e birleşir, mesaj tüm bump\'ları listeler', async () => {
  const t = makeTarget();
  const r1 = await bump(t, 'a');
  const r2 = await bump(t, 'b');
  const r3 = await bump(t, 'a'); // a ikinci kez: en son sha'sı kalır

  assert.equal(r1.status, 'committed');
  assert.equal(r2.status, 'committed');
  assert.equal(r3.status, 'committed');
  assert.equal(count(t), 1); // tek updeps commit
  const [msg] = subjects(t.work);
  assert.equal(msg, 'chore(deps): bump a@3000000, b@2000000');

  // üç güncellemenin hepsi dosyada duruyor
  assert.equal(fs.readFileSync(path.join(t.work, 'deps.lock'), 'utf8').trim().split('\n').length, 3);
  // state: yalnızca güncel commit kayıtlı
  const recorded = loadState().autoCommits[t.work];
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].sha, g(['rev-parse', 'HEAD'], t.work));
});

test('push edilmiş commit\'e dokunulmaz, yeni update ayrı commit olur', async () => {
  const t = makeTarget();
  await bump(t, 'a');
  g(['push', '-q', 'origin', 'main'], t.work);
  await bump(t, 'b');

  assert.equal(count(t), 2); // a (pushed) + b
  assert.match(subjects(t.work)[1], /bump a@/);
});

test('araya giren kullanıcı commit\'i engeller: kullanıcının commit\'i asla katlanmaz', async () => {
  const t = makeTarget();
  await bump(t, 'a');
  fs.writeFileSync(path.join(t.work, 'own.txt'), 'mine\n');
  g(['add', 'own.txt'], t.work);
  g(['commit', '-qm', 'my work'], t.work);
  await bump(t, 'b');

  assert.deepEqual(
    subjects(t.work).slice(0, 3).map((s) => s.replace(/@\w+/g, '@x')),
    ['chore(deps): bump b@x', 'my work', 'chore(deps): bump a@x']
  );
});

test('kullanıcı updeps commit\'ini amend ederse artık tanınmaz, katlanmaz', async () => {
  const t = makeTarget();
  await bump(t, 'a');
  g(['commit', '--amend', '-qm', 'edited by me'], t.work);
  await bump(t, 'b');

  assert.equal(count(t), 2);
  assert.equal(subjects(t.work)[1], 'edited by me');
});

test('squash: false ile ayrı commit\'ler kalır', async () => {
  const t = makeTarget({ squash: false });
  await bump(t, 'a');
  await bump(t, 'b');
  assert.equal(count(t), 2);
});

test('başka bir yerel branch aynı commit\'i içeriyorsa katlanmaz', async () => {
  const t = makeTarget();
  await bump(t, 'a');
  g(['branch', 'keep'], t.work); // keep, a-commit'ini içeriyor
  await bump(t, 'b');
  assert.equal(count(t), 2);
  assert.equal(count(t, 'keep'), 1);
});

test('kullanıcının kirli/staged dosyaları birleştirmeden etkilenmez', async () => {
  const t = makeTarget();
  fs.writeFileSync(path.join(t.work, 'README.md'), '# wip\n');
  fs.writeFileSync(path.join(t.work, 'staged.txt'), 'staged\n');
  g(['add', 'staged.txt'], t.work);
  fs.writeFileSync(path.join(t.work, 'untracked.txt'), 'u\n');
  const statusBefore = g(['status', '--porcelain'], t.work);

  await bump(t, 'a');
  await bump(t, 'b');

  assert.equal(count(t), 1);
  const files = g(['show', '--name-only', '--format=', 'HEAD'], t.work).split('\n');
  assert.deepEqual(files, ['deps.lock']);
  // kullanıcının durumu aynen duruyor (deps.lock commit'lendi, o yüzden listeden çıkmış olur)
  assert.equal(g(['status', '--porcelain'], t.work), statusBefore);
  assert.equal(fs.readFileSync(path.join(t.work, 'README.md'), 'utf8'), '# wip\n');
});

test('birleştirilen commit\'ler reflog\'da kalır (geri alınabilir)', async () => {
  const t = makeTarget();
  await bump(t, 'a');
  const first = g(['rev-parse', 'HEAD'], t.work);
  await bump(t, 'b');
  assert.notEqual(g(['rev-parse', 'HEAD'], t.work), first);
  assert.equal(g(['cat-file', '-t', first], t.work), 'commit'); // obje duruyor
  assert.match(g(['reflog', '-n', '5'], t.work), /updeps: squash/);
});

test('commit.gpgsign açıkken birleştirme yapılmaz', async () => {
  const t = makeTarget();
  await bump(t, 'a');
  const head = g(['rev-parse', 'HEAD'], t.work);
  g(['config', 'commit.gpgsign', 'true'], t.work);
  const recorded = loadState().autoCommits[t.work];
  assert.equal(squashableChain(t.work, 'main', head, recorded), null);
});

test('squashableChain / squashOnto: CAS — branch bu arada ilerlediyse hiçbir şey olmaz', () => {
  const { work } = makeTarget();
  const base = g(['rev-parse', 'HEAD'], work);
  fs.writeFileSync(path.join(work, 'x.txt'), '1\n');
  g(['add', '-A'], work);
  g(['commit', '-qm', 'N'], work);
  const n = g(['rev-parse', 'HEAD'], work);

  // kullanıcı tam o sırada yeni commit atıyor
  fs.writeFileSync(path.join(work, 'x.txt'), '2\n');
  g(['commit', '-aqm', 'user'], work);
  const moved = g(['rev-parse', 'HEAD'], work);

  assert.equal(squashOnto(work, { branch: 'main', base, newSha: n, message: 'squashed' }), null);
  assert.equal(g(['rev-parse', 'HEAD'], work), moved);
});

test('squashOnto: ağaç base ile aynıysa (net değişiklik yok) atlanır', () => {
  const { work } = makeTarget();
  const base = g(['rev-parse', 'HEAD'], work);
  fs.writeFileSync(path.join(work, 'x.txt'), '1\n');
  g(['add', '-A'], work);
  g(['commit', '-qm', 'add'], work);
  g(['rm', '-q', 'x.txt'], work);
  g(['commit', '-qm', 'remove'], work);
  const n = g(['rev-parse', 'HEAD'], work);

  assert.equal(squashOnto(work, { branch: 'main', base, newSha: n, message: 'noop' }), null);
  assert.equal(g(['rev-parse', 'HEAD'], work), n);
});

test('squashOnto: ağaç birebir aynı kalır', async () => {
  const t = makeTarget();
  await bump(t, 'a');
  const treeBefore = (await bump(t, 'b')) && g(['rev-parse', 'HEAD^{tree}'], t.work);
  await bump(t, 'c');
  // c sonrası: tek commit; ağacı, c'nin eklediği satır dahil 3 satırı içerir
  assert.equal(count(t), 1);
  assert.notEqual(g(['rev-parse', 'HEAD^{tree}'], t.work), treeBefore);
  assert.equal(g(['show', 'HEAD:deps.lock'], t.work).trim().split('\n').length, 3);
});

test('kısmen push edilmiş zincirde yalnızca push edilmemiş kısım birleşir', async () => {
  const t = makeTarget();
  await bump(t, 'a');
  g(['push', '-q', 'origin', 'main'], t.work); // a push edildi
  const pushedSha = g(['rev-parse', 'HEAD'], t.work);
  await bump(t, 'b');
  await bump(t, 'c');

  assert.equal(count(t), 2); // a (pushed) + b ve c'nin birleşimi
  assert.equal(g(['rev-parse', 'HEAD^'], t.work), pushedSha);
  assert.match(subjects(t.work)[0], /^chore\(deps\): bump b@\d{7}, c@\d{7}$/);
});

test('birleştirme merge commit\'te durur', async () => {
  const t = makeTarget();
  await bump(t, 'a');
  const recorded = loadState().autoCommits[t.work];
  const aSha = g(['rev-parse', 'HEAD'], t.work);

  g(['checkout', '-q', '-b', 'side', t.baseSha], t.work);
  fs.writeFileSync(path.join(t.work, 'side.txt'), 's\n');
  g(['add', '-A'], t.work);
  g(['commit', '-qm', 'side'], t.work);
  g(['checkout', '-q', 'main'], t.work);
  g(['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], t.work);
  g(['branch', '-q', '-D', 'side'], t.work);

  // merge commit updeps'in değil ve 2 ebeveynli: zincir en üstte kopar
  assert.equal(squashableChain(t.work, 'main', g(['rev-parse', 'HEAD'], t.work), recorded), null);
  assert.equal(g(['cat-file', '-t', aSha], t.work), 'commit');
});
