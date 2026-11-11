import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHatch, tmp } from './helpers.js';

const DIR = fileURLToPath(new URL('../examples/widgets/git/', import.meta.url));
const CLI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
const ctx = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(DIR, 'parse.js'), 'utf8'), ctx);
const raw = ctx.GitParse; // objects from the vm context have another realm's prototypes: round-trip through JSON for deepEqual
const G = { ...raw, parse: (t) => JSON.parse(JSON.stringify(raw.parse(t))), splitPath: (p) => JSON.parse(JSON.stringify(raw.splitPath(p))) };
const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'widget.json'), 'utf8'));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=Test User', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
const cli = (args, cwd, state) => new Promise((resolve) => {
  const p = spawn('node', [CLI, '--state', state, ...args], { cwd, env: { ...process.env, HATCH_STATE: '' } });
  let stdout = ''; let stderr = ''; p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => resolve({ status, stdout, stderr }));
});
const sh = (cmd) => execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
function makeRepo() {
  const d = fs.realpathSync(tmp());
  git(d, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src/a.js'), '1'); fs.writeFileSync(path.join(d, 'b.txt'), '1');
  git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'first'); git(d, 'tag', 'v1');
  fs.writeFileSync(path.join(d, 'src/a.js'), '2'); fs.writeFileSync(path.join(d, 'b.txt'), '2'); git(d, 'add', 'b.txt');
  fs.writeFileSync(path.join(d, 'new file.txt'), 'x'); git(d, 'mv', 'src/a.js', 'src/c.js');
  return d;
}

test('parse: porcelain v2 sections, branch header, refs, rename, spaces in paths, more marker', () => {
  const out = ['@@home /home/u', '@@top /home/u/proj', '@@status', '# branch.oid abcdef0123', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/a.js', '1 M. N... 100644 100644 100644 aaa bbb b.txt', '1 MM N... 100644 100644 100644 aaa bbb both.txt',
    '2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt\told.txt', 'u UU N... 1 2 3 4 aaa bbb ccc clash.txt', '? new file.txt', '@@more 7',
    '@@log', 'abc1234\x1fFix: a thing\x1f1700000000\x1fAda\x1fHEAD -> main, tag: v1, origin/main', 'def5678\x1fplain\x1f1690000000\x1fbob\x1f'].join('\n');
  const s = G.parse(out);
  assert.equal(s.state, 'ok'); assert.equal(s.top, '/home/u/proj'); assert.deepEqual([s.branch.head, s.branch.upstream, s.branch.ahead, s.branch.behind], ['main', 'origin/main', 2, 1]);
  assert.deepEqual(s.unstaged.map((e) => [e.code, e.path]), [['M', 'src/a.js'], ['M', 'both.txt']]);
  assert.deepEqual(s.staged.map((e) => [e.code, e.path]), [['M', 'b.txt'], ['M', 'both.txt'], ['R', 'new name.txt']]);
  assert.equal(s.staged[2].from, 'old.txt'); assert.deepEqual(s.conflicts.map((e) => e.path), ['clash.txt']);
  assert.deepEqual(s.untracked, [{ code: '??', path: 'new file.txt' }]); assert.equal(s.more, 7);
  assert.deepEqual(s.commits[0].refs, [{ name: 'main', kind: 'head' }, { name: 'v1', kind: 'tag' }, { name: 'origin/main', kind: 'remote' }]);
  assert.deepEqual(s.commits[1].refs, []); assert.equal(s.commits[0].subject, 'Fix: a thing');
  assert.equal(G.parse('@@home /h\n@@norepo').state, 'norepo'); assert.equal(G.parse('@@nodir').state, 'nodir');
});

test('helpers: shortPath replaces home and truncates the middle, relTime, splitPath', () => {
  assert.equal(G.shortPath('/home/u/proj', '/home/u'), '~/proj');
  assert.equal(G.shortPath('/home/userx/proj', '/home/u'), '/home/userx/proj');
  const long = G.shortPath('/home/u/a/very/long/path/to/some/project', '/home/u', 20);
  assert.equal(long.length, 20); assert.ok(long.includes('…') && long.startsWith('~/') && long.endsWith('project'));
  const now = 1e12; assert.equal(G.relTime(now / 1000 - 5, now), 'now'); assert.equal(G.relTime(now / 1000 - 300, now), '5m'); assert.equal(G.relTime(now / 1000 - 7200, now), '2h'); assert.equal(G.relTime(now / 1000 - 86400 * 3, now), '3d');
  assert.deepEqual(G.splitPath('a/b/c.js'), { dir: 'a/b/', name: 'c.js' }); assert.deepEqual(G.splitPath('c.js'), { dir: '', name: 'c.js' });
});

test('the source command on a real repository: parses, is read-only, works from a subdirectory path and a non-repo', () => {
  const d = makeRepo();
  const cmd = meta.sources[0].cmd.replaceAll('{{cwd}}', `'${d}'`);
  const before = fs.statSync(path.join(d, '.git/index')).mtimeMs;
  const s = G.parse(sh(cmd));
  assert.equal(s.state, 'ok'); assert.equal(s.top, d); assert.equal(s.branch.head, 'main');
  assert.deepEqual(s.unstaged.map((e) => e.path), ['src/c.js']); // renamed by `git mv`, then edited
  assert.ok(s.staged.some((e) => e.code === 'R' && e.path === 'src/c.js' && e.from === 'src/a.js') && s.staged.some((e) => e.path === 'b.txt'));
  assert.deepEqual(s.untracked.map((e) => e.path), ['new file.txt']);
  assert.equal(s.commits.length, 1); assert.equal(s.commits[0].subject, 'first'); assert.ok(s.commits[0].refs.some((r) => r.kind === 'tag' && r.name === 'v1'));
  assert.equal(fs.statSync(path.join(d, '.git/index')).mtimeMs, before, 'status must not rewrite the index');
  assert.equal(G.parse(sh(meta.sources[0].cmd.replaceAll('{{cwd}}', `'${tmp()}'`))).state, 'norepo');
  assert.equal(G.parse(sh(meta.sources[0].cmd.replaceAll('{{cwd}}', `'${d}/missing'`))).state, 'nodir');
  for (let i = 0; i < 260; i++) fs.writeFileSync(path.join(d, `u${i}.txt`), '');
  const big = G.parse(sh(cmd)); assert.ok(big.more > 0 && big.untracked.length >= 200 && sh(cmd).length < 60000);
});

test('widget open git: one instance per project, titled, quoted dir, reused; collisions get a suffix; bad dirs refused', async () => {
  const h = await startHatch(); const s = h.stateDir;
  try {
    const repo = makeRepo();
    const odd = path.join(fs.realpathSync(tmp()), "it's $HOME `x`"); fs.mkdirSync(odd); git(odd, 'init', '-q');
    let r = await cli(['widget', 'open', 'git'], path.join(repo, 'src'), s); assert.equal(r.status, 0, r.stderr);
    const name = `git-${path.basename(repo)}`.replace(/[^\w-]+/g, '-'); assert.match(r.stdout, new RegExp(`${name} open as w-${name}`));
    const m = JSON.parse(fs.readFileSync(path.join(s, 'widgets', name, 'widget.json'), 'utf8'));
    assert.equal(m.title, `Git: ${path.basename(repo)}`); assert.equal(m.dir, repo); assert.ok(m.sources[0].cmd.startsWith(`cd '${repo}' `)); assert.ok(fs.existsSync(path.join(s, 'widgets', name, 'parse.js')));
    assert.equal((await h.call('GET', '/api/panels')).data.find((p) => p.id === `w-${name}`).title, `Git: ${path.basename(repo)}`);
    fs.writeFileSync(path.join(s, 'widgets', name, 'marker'), 'keep');
    r = await cli(['widget', 'open', 'git'], repo, s); assert.match(r.stdout, new RegExp(`${name} open as`)); assert.ok(fs.existsSync(path.join(s, 'widgets', name, 'marker')), 'reused, not recreated');
    assert.equal((await h.call('GET', '/api/panels')).data.filter((p) => p.type === 'widget').length, 1);
    r = await cli(['widget', 'open', 'git'], odd, s); assert.equal(r.status, 0, r.stderr);
    const oddName = r.stdout.match(/widget (\S+) open/)[1];
    const om = JSON.parse(fs.readFileSync(path.join(s, 'widgets', oddName, 'widget.json'), 'utf8'));
    assert.equal(G.parse(sh(om.sources[0].cmd)).top, odd, 'quotes, $ and backticks in the path survive');
    // same folder name, different parent: separate widget with a hash suffix
    const other = path.join(fs.realpathSync(tmp()), path.basename(repo)); fs.mkdirSync(other); git(other, 'init', '-q');
    r = await cli(['widget', 'open', 'git'], other, s); assert.equal(r.status, 0, r.stderr); const n2 = r.stdout.match(/widget (\S+) open/)[1]; assert.notEqual(n2, name); assert.ok(n2.startsWith(`${name}-`));
    // a plain (palette) open without a dir keeps the generic widget
    assert.equal((await h.call('POST', '/api/examples/git/open', {})).data.id, 'w-git');
    // validation
    for (const dir of ['relative/path', path.join(repo, 'nope'), path.join(repo, 'b.txt'), 5]) assert.equal((await h.call('POST', '/api/examples/git/open', { dir })).status, 400, String(dir));
    // other widgets still work through the CLI
    r = await cli(['widget', 'open', 'cpu'], repo, s); assert.match(r.stdout, /cpu open as w-cpu/);
    r = await cli(['widget', 'rm', name], repo, s); assert.equal(r.status, 0, r.stderr);
  } finally { await h.close(); }
});

test('git widget command asks git for only the 5 most recent commits', () => {
  const w = JSON.parse(fs.readFileSync(new URL('../examples/widgets/git/widget.json', import.meta.url), 'utf8'));
  assert.match(JSON.stringify(w), / log --format=\S+ -n 5 /);
});
