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
const J = (f) => (...a) => JSON.parse(JSON.stringify(f(...a)));
const G = { ...raw, parseShow: J(raw.parseShow), parseFileDiff: J(raw.parseFileDiff), parseDiff: J(raw.parseDiff), parseNumstat: J(raw.parseNumstat), statBars: J(raw.statBars), parse: (t) => JSON.parse(JSON.stringify(raw.parse(t))), splitPath: (p) => JSON.parse(JSON.stringify(raw.splitPath(p))) };
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

test('recent activity: reflog events from a real repo (branch, commit, worktree) are deduplicated and described; empty repo hides it', () => {
  const d = makeRepo();
  git(d, 'branch', 'feature'); git(d, 'checkout', '-q', 'feature');
  fs.writeFileSync(path.join(d, 'f.txt'), 'x'); git(d, 'add', 'f.txt'); git(d, 'commit', '-q', '-m', 'work on feature');
  git(d, 'worktree', 'add', '-q', '-b', 'side', path.join(fs.realpathSync(tmp()), 'wt'));
  const s = G.parse(sh(meta.sources[0].cmd.replaceAll('{{cwd}}', `'${d}'`)));
  const texts = s.activity.map((a) => a.text);
  assert.ok(s.activity.length >= 3 && s.activity.length <= 5, texts.join(' | '));
  assert.ok(texts.includes('created branch side'), texts.join(' | '));
  assert.equal(s.activity.find((a) => a.text === 'created branch side').kind, 'branch');
  assert.equal(s.activity.find((a) => a.text === 'commit on feature: work on feature').kind, 'commit');
  assert.ok(texts.includes('commit on feature: work on feature'), 'one entry per event, named after the branch');
  assert.ok(texts.includes('created branch feature') || texts.some((t) => t.startsWith('checkout main')), texts.join(' | '));
  assert.equal(new Set(s.activity.map((a) => `${a.ts}${a.text}`)).size, s.activity.length);
  assert.deepEqual(G.parse('@@top /x\n@@status\n@@log\n@@activity\n').activity, []);
  const fresh = fs.realpathSync(tmp()); git(fresh, 'init', '-q');
  assert.deepEqual(G.parse(sh(meta.sources[0].cmd.replaceAll('{{cwd}}', `'${fresh}'`))).activity, []);
});

test('parseActivity: drops fetch and push noise, prefers branch over HEAD, caps at 5', () => {
  const US = '\x1f';
  const lines = ['9\x1forigin/main@{0}\x1fupdate by push\x1faaa', '8\x1fmain@{0}\x1fcommit: a\x1fbbb', '8\x1fHEAD@{0}\x1fcommit: a\x1fbbb', '7\x1forigin/x@{0}\x1ffetch origin: fast-forward\x1fccc',
    ...[6, 5, 4, 3, 2, 1].map((n) => `${n}${US}HEAD@{${n}}${US}checkout: moving from a${n} to b${n}${US}h${n}`)];
  const a = JSON.parse(JSON.stringify(raw.parseActivity(lines)));
  assert.equal(a.length, 5); assert.equal(a[0].text, 'commit on main: a'); assert.equal(a[1].text, 'checkout a6 → b6');
});

test('parseActivity: every reflog message maps to a kind (icon), unknown ones to other', () => {
  const US = '\x1f';
  const cases = [['HEAD', 'commit: a', 'commit'], ['main', 'commit (initial): a', 'first'], ['main', 'commit (amend): a', 'amend'], ['main', 'commit (merge): a', 'mergecommit'],
    ['main', 'merge feature: Fast-forward', 'merge'], ['HEAD', 'checkout: moving from a to b', 'checkout'], ['x', 'branch: Created from HEAD', 'branch'],
    ['x', 'branch: Reset to main', 'reset'], ['HEAD', 'reset: moving to HEAD~1', 'reset'], ['HEAD', 'rebase (finish): returning to refs/heads/x', 'rebase'],
    ['HEAD', 'cherry-pick: a', 'cherry'], ['HEAD', 'pull: something odd', 'other']];
  const lines = cases.map(([ref, msg], i) => `${100 - i}${US}${ref}@{0}${US}${msg}${US}h${i}`);
  const kinds = JSON.parse(JSON.stringify(raw.parseActivity(lines, 99))).map((a) => a.kind);
  assert.deepEqual(kinds, cases.map((c) => c[2]));
});

test('commit rows: author initials only with several authors; the checked-out branch pill is dropped', () => {
  assert.equal(G.multiAuthor([{ author: 'Ann' }, { author: 'Ann' }]), false);
  assert.equal(G.multiAuthor([{ author: 'Ann' }, { author: 'Bob' }]), true);
  assert.equal(G.multiAuthor([]), false);
  const refs = G.parseRefs('HEAD -> main, tag: v1, origin/main, dev');
  assert.equal(G.rowRefs(refs, 'main').map((r) => r.name).join(), 'v1,origin/main,dev');
  assert.equal(G.rowRefs(G.parseRefs('HEAD'), '(detached)').length, 1);
});

// ---- inspect: commit and file views ----
const src = (name) => meta.sources.find((x) => x.name === name);
const run = (name, d, arg) => execFileSync('/bin/sh', ['-c', src(name).cmd.replaceAll('{{cwd}}', `'${d}'`)], { encoding: 'utf8', env: { ...process.env, HATCH_ARG: arg } }).trim();

test('parseDiff: statuses, renames, binary, hunks and line kinds; a "---" line inside a hunk is a deletion', () => {
  const f = G.parseDiff([
    'diff --git a/x.txt b/x.txt', 'index 1..2 100644', '--- a/x.txt', '+++ b/x.txt', '@@ -1,3 +1,3 @@ fn', ' keep', '--- gone', '+new', '\\ No newline at end of file',
    'diff --git a/old name.js b/new name.js', 'similarity index 90%', 'rename from old name.js', 'rename to new name.js', '--- a/old name.js', '+++ b/new name.js', '@@ -1 +1 @@', '-a', '+b',
    'diff --git a/n.bin b/n.bin', 'new file mode 100644', 'Binary files /dev/null and b/n.bin differ',
    'diff --git a/del.txt b/del.txt', 'deleted file mode 100644', '--- a/del.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
  ].join('\n'));
  assert.deepEqual(f.map((x) => [x.path, x.from, x.status, x.binary, x.add, x.del]), [['x.txt', '', 'M', false, 1, 1], ['new name.js', 'old name.js', 'R', false, 1, 1], ['n.bin', '', 'A', true, 0, 0], ['del.txt', '', 'D', false, 0, 1]]);
  assert.deepEqual(f[0].hunks[0].lines.map((l) => l.t + l.s), [' keep', '--- gone', '+new', '\\ No newline at end of file']);
  assert.equal(f[0].hunks[0].head, '@@ -1,3 +1,3 @@ fn');
  assert.deepEqual(G.parseDiff(''), []);
  const cut = G.parseDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+');   // a patch cut mid-way keeps what arrived
  assert.deepEqual([cut[0].add, cut[0].del, cut[0].hunks[0].lines.length], [1, 1, 2]);
});

test('parseNumstat and statBars: renames, binary, proportional bars with a minimum of one cell', () => {
  const n = G.parseNumstat('3\t1\ta.js\0-\t-\timg.png\0\x32\t0\t\0old.js\0new.js\0');
  assert.deepEqual(n.map((x) => [x.path, x.from, x.add, x.del, x.binary]), [['a.js', '', 3, 1, false], ['img.png', '', 0, 0, true], ['new.js', 'old.js', 2, 0, false]]);
  assert.deepEqual(G.statBars([{ add: 100, del: 100 }, { add: 1, del: 0 }, { add: 0, del: 0 }], 20), [{ plus: 10, minus: 10 }, { plus: 1, minus: 0 }, { plus: 0, minus: 0 }]);
  assert.deepEqual(G.statBars([{ add: 3, del: 2 }], 20), [{ plus: 3, minus: 2 }]);
});

test('commit view on a real repo: header, stat and patch parse; merges, root commits, bad hashes and injection attempts are handled', () => {
  const d = makeRepo(); git(d, 'commit', '-q', '-am', 'second\n\nbody line');
  fs.writeFileSync(path.join(d, '--weird $(touch pwned) name'), 'x\n'); git(d, 'add', '--', '--weird $(touch pwned) name'); git(d, 'commit', '-q', '-m', 'odd');
  const head = git(d, 'rev-parse', 'HEAD').trim(); const root = git(d, 'rev-parse', 'HEAD~2').trim();
  const r = G.parseShow(run('show', d, head.slice(0, 9)));
  assert.equal(r.state, 'ok'); assert.equal(r.hash, head); assert.equal(r.subject, 'odd'); assert.equal(r.author, 'Test User'); assert.equal(r.parents.length, 1);
  assert.deepEqual(r.files.map((f) => [f.path, f.status, f.add, f.del]), [['--weird $(touch pwned) name', 'A', 1, 0]]);
  assert.ok(!fs.existsSync(path.join(d, 'pwned')));
  const second = G.parseShow(run('show', d, git(d, 'rev-parse', 'HEAD~1').trim()));
  assert.equal(second.subject, 'second'); assert.equal(second.body, 'body line');
  assert.ok(second.files.some((f) => f.path === 'src/c.js'), 'the renamed and edited file is listed');
  const first = G.parseShow(run('show', d, root)); assert.deepEqual(first.files.map((f) => f.status), ['A', 'A']);
  for (const bad of ['', 'nothex', '--all', '$(id)', 'deadbeefdeadbeef', head + ';ls']) assert.equal(G.parseShow(run('show', d, bad)).state, 'bad', bad);
  assert.equal(G.parseShow(run('show', d, 'abc')).state, 'bad');
  // merge: shown against the first parent
  git(d, 'checkout', '-q', '-b', 'side', root); fs.writeFileSync(path.join(d, 'side.txt'), 's\n'); git(d, 'add', 'side.txt'); git(d, 'commit', '-q', '-m', 'side');
  git(d, 'checkout', '-q', 'main'); git(d, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  const m = G.parseShow(run('show', d, git(d, 'rev-parse', 'HEAD').trim())); assert.equal(m.parents.length, 2); assert.deepEqual(m.files.map((f) => f.path), ['side.txt']);
});

test('commit view: a patch over 40 KB is cut and flagged, the stat still lists every file, one file can be loaded alone', () => {
  const d = fs.realpathSync(tmp()); git(d, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(d, 'keep'), '1');
  for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(d, `${n}.txt`), `${n}\n`.repeat(n === 'a' ? 30000 : 9000));
  git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'big'); const h = git(d, 'rev-parse', 'HEAD').trim();
  const r = G.parseShow(run('show', d, h));
  assert.equal(r.truncated, true); assert.deepEqual(r.files.map((f) => f.path), ['a.txt', 'b.txt', 'c.txt', 'keep']);
  assert.ok(r.files[0].diff && !r.files[3].diff, 'files after the cut have no patch');
  const one = G.parseFileDiff(run('diff', d, G.diffArg('commit', h, 'keep', '')));
  assert.equal(one.files[0].path, 'keep'); assert.equal(one.truncated, false);
  assert.equal(G.parseFileDiff(run('diff', d, G.diffArg('commit', h, 'a.txt', ''))).truncated, true);
});

test('file view: unstaged, staged (rename), untracked (file, folder, binary), conflict; odd names; read-only', () => {
  const d = makeRepo(); fs.writeFileSync(path.join(d, 'src/c.js'), '3\n'); fs.mkdirSync(path.join(d, 'dir with space')); fs.writeFileSync(path.join(d, 'dir with space/-f $(x).txt'), 'q\n'); fs.writeFileSync(path.join(d, 'img.bin'), Buffer.from([0, 1, 2, 0, 255]));
  const before = fs.statSync(path.join(d, '.git/index')).mtimeMs;
  const un = G.parseFileDiff(run('diff', d, G.diffArg('unstaged', '', 'src/c.js', '')));
  assert.deepEqual(un.files.map((f) => [f.path, f.add]), [['src/c.js', 1]]);
  const st = G.parseFileDiff(run('diff', d, G.diffArg('staged', '', 'src/c.js', 'src/a.js')));
  assert.deepEqual(st.files.map((f) => [f.path, f.from, f.status]), [['src/c.js', 'src/a.js', 'R']]);
  const nu = G.parseFileDiff(run('diff', d, G.diffArg('untracked', '', 'new file.txt', '')));
  assert.deepEqual(nu.files.map((f) => [f.path, f.status, f.add]), [['new file.txt', 'A', 1]]);
  assert.equal(G.parseFileDiff(run('diff', d, G.diffArg('untracked', '', 'img.bin', ''))).files[0].binary, true);
  assert.deepEqual(G.parseFileDiff(run('diff', d, G.diffArg('untracked', '', 'dir with space/', ''))).list, ['dir with space/-f $(x).txt']);
  assert.equal(G.parseFileDiff(run('diff', d, G.diffArg('untracked', '', 'dir with space/-f $(x).txt', ''))).files[0].add, 1);
  assert.equal(G.parseFileDiff(run('diff', d, 'bogus\t-\tx\t')).state, 'bad');
  assert.equal(G.parseFileDiff(run('diff', d, G.diffArg('commit', '', 'x', ''))).state, 'bad', 'commit mode needs a hex ref');
  assert.equal(G.parseFileDiff(run('diff', d, G.diffArg('unstaged', '', '--output=pwned', ''))).files.length, 0);
  assert.ok(!fs.existsSync(path.join(d, 'pwned')));
  assert.equal(fs.statSync(path.join(d, '.git/index')).mtimeMs, before, 'read-only');
  assert.equal(G.diffArg('unstaged', '', 'a\tb', ''), null); assert.equal(G.diffArg('unstaged', '', 'a\nb', ''), null);
  // conflict
  const c = fs.realpathSync(tmp()); git(c, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(c, 'b.txt'), 'base\n'); git(c, 'add', '.'); git(c, 'commit', '-q', '-m', 'base');
  git(c, 'checkout', '-q', '-b', 'x1'); fs.writeFileSync(path.join(c, 'b.txt'), 'x1 side\n'); git(c, 'commit', '-q', '-am', 'x1');
  git(c, 'checkout', '-q', 'main'); fs.writeFileSync(path.join(c, 'b.txt'), 'main side\n'); git(c, 'commit', '-q', '-am', 'm');
  try { git(c, 'merge', 'x1'); } catch { /* conflict expected */ }
  const cf = G.parseFileDiff(run('diff', c, G.diffArg('unstaged', '', 'b.txt', '')));
  assert.equal(cf.files.length, 1); assert.ok(cf.files[0].hunks[0].lines.some((l) => l.t === '+' && l.s.includes('<<<<<<<')));
});

test('the diff and show sources accept any path as a call argument, other sources keep the strict rule', async () => {
  const h = await startHatch();
  try {
    await h.call('PUT', '/api/widgets/anyarg', widgetMeta2([{ name: 'p', kind: 'exec', arg: 'any', cmd: 'printf %s "$HATCH_ARG"' }, { name: 'q', kind: 'exec', cmd: 'printf %s "$HATCH_ARG"' }]));
    const ok = await h.call('POST', '/api/call', { widget: 'anyarg', source: 'p', arg: 'unstaged\t-\tsrc/a b.js\t' });
    assert.equal(ok.status, 200); assert.equal(ok.data.value.out, 'unstaged\t-\tsrc/a b.js'); // run output is trimmed
    assert.equal((await h.call('POST', '/api/call', { widget: 'anyarg', source: 'p', arg: 'a\nb' })).status, 400);
    assert.equal((await h.call('POST', '/api/call', { widget: 'anyarg', source: 'p', arg: 'x'.repeat(4001) })).status, 400);
    assert.equal((await h.call('POST', '/api/call', { widget: 'anyarg', source: 'q', arg: 'src/a.js' })).status, 400);
  } finally { await h.close(); }
});
const widgetMeta2 = (sources) => ({ files: { 'index.html': 'x' }, meta: { sources } });
