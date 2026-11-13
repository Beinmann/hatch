import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHatch, tmp, PNG } from './helpers.js';

const DIR = fileURLToPath(new URL('../examples/widgets/files/', import.meta.url));
const CLI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
const ctx = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(DIR, 'model.js'), 'utf8'), ctx);
const J = (v) => JSON.parse(JSON.stringify(v)); // objects from the vm context have another realm's prototypes
const M = ctx.FilesModel;
const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'widget.json'), 'utf8'));
const cmdOf = (name) => meta.sources.find((s) => s.name === name).cmd;
const run = (name, arg) => execFileSync('/bin/sh', ['-c', cmdOf(name)], { encoding: 'utf8', env: { ...process.env, HATCH_ARG: arg }, maxBuffer: 8 << 20 }).trim();
const cli = (args, cwd, state) => new Promise((resolve) => {
  const p = spawn('node', [CLI, '--state', state, ...args], { cwd, env: { ...process.env, HATCH_STATE: '' } });
  let stdout = ''; let stderr = ''; p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => resolve({ status, stdout, stderr }));
});

test('paths: parent, join, base name, safety check', () => {
  assert.equal(M.parentOf('/a/b/c'), '/a/b'); assert.equal(M.parentOf('/a'), '/'); assert.equal(M.parentOf('/'), '/'); assert.equal(M.parentOf('/a/b/'), '/a');
  assert.equal(M.joinPath('/', 'x'), '/x'); assert.equal(M.joinPath('/a/b', 'x y'), '/a/b/x y');
  assert.equal(M.baseName('/a/b'), 'b'); assert.equal(M.baseName('/'), '/');
  assert.ok(M.pathOk('/a/b c/d')); assert.ok(!M.pathOk('rel/path')); assert.ok(!M.pathOk('/a\nb')); assert.ok(M.pathOk('/a\tb'), 'tab is allowed by the server'); assert.ok(!M.pathOk('/' + 'x'.repeat(4000))); assert.ok(!M.pathOk(null));
});

test('listing: folders first, natural order, hidden only on request, symlinks to folders count as folders', () => {
  const mk = (name, isDir = false) => ({ name, isDir });
  const all = [mk('b.txt'), mk('.env'), mk('file10'), mk('file2'), mk('Zeta', true), mk('alpha', true), mk('.git', true)];
  assert.deepEqual(J(M.listing(all, false)).map((e) => e.name), ['alpha', 'Zeta', 'b.txt', 'file2', 'file10']);
  assert.deepEqual(J(M.listing(all, true)).map((e) => e.name), ['.git', 'alpha', 'Zeta', '.env', 'b.txt', 'file2', 'file10']);
  assert.equal(M.indexOfName(M.listing(all, false), 'Zeta'), 1); assert.equal(M.indexOfName(M.listing(all, false), '.env'), -1);
});

test('move: clamps, handles empty lists', () => {
  assert.equal(M.move(0, 1, 3), 1); assert.equal(M.move(2, 1, 3), 2); assert.equal(M.move(0, -1, 3), 0); assert.equal(M.move(-1, 1, 3), 1); assert.equal(M.move(0, 1, 0), -1);
  assert.equal(M.move(1, -9999, 5), 0); assert.equal(M.move(1, 9999, 5), 4);
});

test('formatting: sizes, image types by extension', () => {
  assert.deepEqual([0, 1023, 1024, 1536, 1048576, 5 * 1073741824].map(M.formatSize), ['0 B', '1023 B', '1.0 KB', '1.5 KB', '1.0 MB', '5.0 GB']);
  assert.equal(M.formatSize(-1), '?'); assert.equal(M.formatSize(NaN), '?');
  assert.equal(M.imageMime('a.PNG'), 'image/png'); assert.equal(M.imageMime('x.jpeg'), 'image/jpeg'); assert.equal(M.imageMime('x.svg'), 'image/svg+xml'); assert.equal(M.imageMime('x.txt'), null); assert.equal(M.imageMime('png'), null);
});

test('parseLs and parsePeek turn errors and odd output into messages, never throw', () => {
  assert.deepEqual(J(M.parseLs('@@err permission denied')), { state: 'err', error: 'permission denied' });
  assert.equal(M.parseLs('').state, 'err'); assert.equal(M.parseLs(undefined).state, 'err'); assert.equal(M.parseLs('garbage').state, 'err');
  assert.equal(M.parsePeek('@@err permission denied').error, 'permission denied'); assert.equal(M.parsePeek('').state, 'err'); assert.equal(M.parsePeek(null).state, 'err');
  const long = `@@real /x\n@@entries\n${Array.from({ length: M.LIST_LIMIT + 1 }, (_, i) => `ff\x1f1\x1f0\x1f\x1fn${i}\0`).join('')}`;
  const r = M.parseLs(long); assert.equal(r.entries.length, M.LIST_LIMIT); assert.equal(r.truncated, true);
});

// ---- the real source commands ----
function fixture() {
  const d = fs.realpathSync(tmp());
  fs.mkdirSync(path.join(d, 'sub')); fs.mkdirSync(path.join(d, '.hid'));
  fs.writeFileSync(path.join(d, 'a.txt'), 'hello\nworld\n'); fs.writeFileSync(path.join(d, '.secret'), 'x'); fs.writeFileSync(path.join(d, 'pic.PNG'), PNG);
  fs.writeFileSync(path.join(d, 'bin.dat'), Buffer.from([1, 2, 0, 3, 4])); fs.writeFileSync(path.join(d, 'empty.txt'), '');
  fs.writeFileSync(path.join(d, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(d, 'weird $(touch pwned) `x` \'q\'.txt'), 'safe');
  fs.symlinkSync('sub', path.join(d, 'linkdir')); fs.symlinkSync('nowhere', path.join(d, 'broken'));
  return d;
}

test('ls source: lists with types, sizes, symlinks, hidden files; parent via real path', () => {
  const d = fixture();
  const r = M.parseLs(run('ls', d)); assert.equal(r.state, 'ok'); assert.equal(r.real, d);
  const by = Object.fromEntries(r.entries.map((e) => [e.name, e]));
  assert.ok(by.sub.isDir && by['.hid'].isDir && by.linkdir.isDir && by.linkdir.link === 'sub'); assert.ok(by.broken.broken && !by.broken.isDir);
  assert.equal(by['a.txt'].size, 12); assert.ok(!by['a.txt'].isDir);
  assert.deepEqual(J(M.listing(r.entries, false)).map((e) => e.name).slice(0, 3), ['linkdir', 'sub', 'a.txt']);
  assert.ok(M.listing(r.entries, true).some((e) => e.name === '.secret'));
  assert.equal(M.parseLs(run('ls', `${d}/sub/../sub`)).real, path.join(d, 'sub'), 'normalised');
  assert.equal(M.parseLs(run('ls', path.join(d, 'sub'))).entries.length, 0);
  assert.equal(fs.existsSync(path.join(d, 'pwned')), false);
});

test('ls source: bad paths give messages (relative, missing, file, injection-looking), large folders are capped', () => {
  const d = fixture();
  assert.match(M.parseLs(run('ls', 'relative')).error, /absolute/);
  assert.match(M.parseLs(run('ls', path.join(d, 'nope'))).error, /no such folder/);
  assert.match(M.parseLs(run('ls', path.join(d, 'a.txt'))).error, /not a folder/);
  assert.match(M.parseLs(run('ls', `${d}; touch ${d}/pwned`)).error, /no such folder/); assert.equal(fs.existsSync(path.join(d, 'pwned')), false);
  assert.equal(M.parseLs(run('ls', '/')).state, 'ok');
  const big = path.join(d, 'big'); fs.mkdirSync(big); for (let i = 0; i < M.LIST_LIMIT + 50; i++) fs.writeFileSync(path.join(big, `f${i}`), '');
  const r = M.parseLs(run('ls', big)); assert.equal(r.entries.length, M.LIST_LIMIT); assert.equal(r.truncated, true);
  if (process.getuid && process.getuid() !== 0) {
    const locked = path.join(d, 'locked'); fs.mkdirSync(locked); fs.chmodSync(locked, 0);
    try { assert.match(M.parseLs(run('ls', locked)).error, /permission denied/); } finally { fs.chmodSync(locked, 0o755); }
  }
});

test('peek source: text, truncation, images, binary, empty, special files, unreadable, bad paths', () => {
  const d = fixture();
  let p = M.parsePeek(run('peek', path.join(d, 'a.txt'))); assert.equal(p.kind, 'text'); assert.equal(p.text, 'hello\nworld'); assert.equal(p.size, 12); assert.ok(!p.truncated);
  p = M.parsePeek(run('peek', path.join(d, 'empty.txt'))); assert.equal(p.kind, 'text'); assert.equal(p.text, '');
  p = M.parsePeek(run('peek', path.join(d, 'pic.PNG'))); assert.equal(p.kind, 'image'); assert.equal(p.mime, 'image/png'); assert.equal(p.dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
  p = M.parsePeek(run('peek', path.join(d, 'logo.svg'))); assert.equal(p.kind, 'image'); assert.equal(p.mime, 'image/svg+xml');
  p = M.parsePeek(run('peek', path.join(d, 'bin.dat'))); assert.equal(p.kind, 'binary'); assert.equal(p.size, 5);
  fs.writeFileSync(path.join(d, 'ctl.dat'), Buffer.from('abc\x01\x02def\x03 more text here')); assert.equal(M.parsePeek(run('peek', path.join(d, 'ctl.dat'))).kind, 'binary', 'control characters without NUL');
  fs.writeFileSync(path.join(d, 'color.log'), '\x1b[31mred\x1b[0m\ttab\r\nline\n'); assert.equal(M.parsePeek(run('peek', path.join(d, 'color.log'))).kind, 'text', 'tabs, CR and colour codes are text');
  fs.writeFileSync(path.join(d, 'utf.txt'), 'héllo wörld ✓\n'); assert.equal(M.parsePeek(run('peek', path.join(d, 'utf.txt'))).text, 'héllo wörld ✓');
  fs.writeFileSync(path.join(d, 'long.txt'), 'y'.repeat(70000));
  p = M.parsePeek(run('peek', path.join(d, 'long.txt'))); assert.equal(p.kind, 'text'); assert.equal(p.text.length, 65536); assert.ok(p.truncated); assert.equal(p.size, 70000);
  fs.writeFileSync(path.join(d, 'huge.png'), Buffer.alloc(2200000, 1)); assert.equal(M.parsePeek(run('peek', path.join(d, 'huge.png'))).kind, 'bigimage');
  execFileSync('mkfifo', [path.join(d, 'pipe')]); assert.equal(M.parsePeek(run('peek', path.join(d, 'pipe'))).kind, 'special'); // must not block reading it
  assert.equal(M.parsePeek(run('peek', path.join(d, 'sub'))).kind, 'special');
  assert.equal(M.parsePeek(run('peek', path.join(d, 'weird $(touch pwned) `x` \'q\'.txt'))).text, 'safe'); assert.equal(fs.existsSync(path.join(d, 'pwned')), false);
  assert.match(M.parsePeek(run('peek', 'rel')).error, /absolute/); assert.match(M.parsePeek(run('peek', path.join(d, 'nope'))).error, /no such file/);
  assert.match(M.parsePeek(run('peek', path.join(d, 'broken'))).error, /no such file/);
  if (process.getuid && process.getuid() !== 0) {
    const f = path.join(d, 'locked.txt'); fs.writeFileSync(f, 'x'); fs.chmodSync(f, 0);
    assert.match(M.parsePeek(run('peek', f)).error, /permission denied/);
  }
});

test('the sources never write: they only use read commands', () => {
  for (const s of meta.sources) assert.doesNotMatch(s.cmd.replaceAll('2>/dev/null', ''), /\b(rm|mv|cp|touch|mkdir|chmod|chown|dd|tee|truncate|ln|sed -i)\b|>>?\s*[^&\s]/, s.name);
});

test('widget open files: opens in the caller folder through the CLI, reuses it, large output allowed through hatch.call', async () => {
  const h = await startHatch(); const s = h.stateDir;
  try {
    const d = fixture();
    let r = await cli(['widget', 'open', 'files'], path.join(d, 'sub'), s); assert.equal(r.status, 0, r.stderr);
    const name = `files-sub`; assert.match(r.stdout, new RegExp(`${name} open as w-${name}`));
    const m = JSON.parse(fs.readFileSync(path.join(s, 'widgets', name, 'widget.json'), 'utf8'));
    assert.equal(m.title, 'Files: sub'); assert.equal(m.dir, path.join(d, 'sub')); assert.ok(fs.existsSync(path.join(s, 'widgets', name, 'model.js')));
    const start = execFileSync('/bin/sh', ['-c', m.sources.find((x) => x.name === 'start').cmd], { encoding: 'utf8' }); assert.equal(start, path.join(d, 'sub'));
    r = await cli(['widget', 'open', 'files'], path.join(d, 'sub'), s); assert.equal(r.status, 0); assert.equal((await h.call('GET', '/api/panels')).data.filter((p) => p.type === 'widget').length, 1);
    for (const dir of ['relative', path.join(d, 'nope'), path.join(d, 'a.txt'), 5]) assert.equal((await h.call('POST', '/api/examples/files/open', { dir })).status, 400, String(dir));
    // an image of ~1 MB goes through hatch.call (the default exec output limit is 64 KB)
    fs.writeFileSync(path.join(d, 'photo.png'), Buffer.alloc(1000000, 7));
    const c = await h.call('POST', '/api/call', { widget: name, source: 'peek', arg: path.join(d, 'photo.png') });
    assert.equal(c.status, 200); assert.equal(M.parsePeek(c.data.value.out).kind, 'image'); assert.ok(!c.data.value.error);
    const l = await h.call('POST', '/api/call', { widget: name, source: 'ls', arg: d }); assert.equal(M.parseLs(l.data.value.out).state, 'ok');
    assert.equal((await h.call('POST', '/api/call', { widget: name, source: 'ls', arg: 'a\nb' })).status, 400);
  } finally { await h.close(); }
});
