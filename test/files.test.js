import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { list, readText, writeText, saveFile } from '../src/files.js';
import { startHatch, tmp } from './helpers.js';

test('list sorts dirs first, shows parent, rejects relative paths', () => {
  const d = tmp(); fs.mkdirSync(path.join(d, 'sub')); fs.writeFileSync(path.join(d, 'a.txt'), 'x'); fs.symlinkSync('/nonexistent-target', path.join(d, 'dead'));
  const r = list(d);
  assert.deepEqual(r.entries.map((e) => e.name), ['sub', 'a.txt', 'dead']);
  assert.equal(r.entries[2].type, 'broken'); assert.equal(r.parent, path.dirname(d));
  assert.throws(() => list('relative'), /absolute/);
  assert.throws(() => list(path.join(d, 'nope')), /no such file/);
});

test('readText refuses binaries and big files; writeText is atomic, keeps mode, detects conflicts', () => {
  const d = tmp(); const f = path.join(d, 's.sh');
  fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 });
  const r = readText(f);
  assert.equal(r.text, '#!/bin/sh\n');
  const w = writeText(f, 'echo hi\n', r.mtime);
  assert.equal(fs.statSync(f).mode & 0o777, 0o755); assert.equal(fs.readFileSync(f, 'utf8'), 'echo hi\n');
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  assert.throws(() => writeText(f, 'stale', w.mtime), /changed on disk/);
  fs.writeFileSync(path.join(d, 'bin'), Buffer.from([1, 0, 2]));
  assert.throws(() => readText(path.join(d, 'bin')), /binary/);
  assert.equal(writeText(path.join(d, 'new.txt'), 'fresh').size, 5);
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.endsWith('.tmp')), []);
});

test('saveFile keeps only the base name and refuses to overwrite', () => {
  const d = tmp();
  assert.equal(path.basename(saveFile(d, '../../evil.txt', Buffer.from('x')).path), 'evil.txt');
  assert.ok(fs.existsSync(path.join(d, 'evil.txt')));
  assert.throws(() => saveFile(d, 'evil.txt', Buffer.from('y')), /already exists/);
  assert.equal(saveFile(d, 'evil.txt', Buffer.from('y'), true).bytes, 1);
  assert.throws(() => saveFile(d, '', Buffer.from('y')), /name/);
});

test('fs API: list, read, write, upload, download, editor and files panels', async () => {
  const h = await startHatch();
  try {
    fs.writeFileSync(path.join(h.dir, 'n.txt'), 'hello');
    assert.ok((await h.call('GET', `/api/fs/list?path=${encodeURIComponent(h.dir)}`)).data.entries.some((e) => e.name === 'n.txt'));
    assert.equal((await h.call('GET', `/api/fs/read?path=${encodeURIComponent(path.join(h.dir, 'n.txt'))}`)).data.text, 'hello');
    assert.equal((await h.call('PUT', '/api/fs/write', { path: path.join(h.dir, 'n.txt'), text: 'bye' })).status, 200);
    assert.equal((await h.call('POST', `/api/fs/upload?dir=${encodeURIComponent(h.dir)}&name=up.bin`, Buffer.from([0, 1, 2]), { 'content-type': 'application/octet-stream' })).status, 200);
    assert.equal((await h.call('POST', `/api/fs/upload?dir=${encodeURIComponent(h.dir)}&name=up.bin`, Buffer.from([9]), { 'content-type': 'application/octet-stream' })).status, 409);
    const dl = await fetch(`${h.base}/api/fs/download?path=${encodeURIComponent(path.join(h.dir, 'up.bin'))}`, { headers: { 'x-token': h.hatch.token } });
    assert.match(dl.headers.get('content-disposition'), /attachment/); assert.equal((await dl.arrayBuffer()).byteLength, 3);
    assert.equal((await h.call('GET', '/api/fs/read?path=nope')).status, 400);
    assert.equal((await h.call('POST', '/api/panels', { type: 'editor', props: { path: path.join(h.dir, 'n.txt') } })).status, 201);
    assert.equal((await h.call('POST', '/api/panels', { type: 'files', props: { path: h.dir } })).status, 201);
    assert.equal((await h.call('POST', '/api/panels', { type: 'editor', props: {} })).status, 400);
  } finally { await h.close(); }
});

test('fs resolve: relative paths are looked up against the server dir, missing ones say where it looked', async () => {
  const h = await startHatch();
  try {
    fs.mkdirSync(path.join(h.dir, 'src')); fs.writeFileSync(path.join(h.dir, 'src', 'a.js'), 'x');
    assert.equal((await h.call('GET', '/api/fs/resolve?path=src/a.js')).data.path, path.join(h.dir, 'src', 'a.js'));
    assert.equal((await h.call('GET', `/api/fs/resolve?path=${encodeURIComponent(path.join(h.dir, 'src', 'a.js'))}`)).status, 200);
    const miss = await h.call('GET', '/api/fs/resolve?path=nope/b.js'); assert.equal(miss.status, 404); assert.match(miss.data.error, /looked in/);
    assert.equal((await h.call('GET', '/api/fs/resolve?path=src')).status, 404, 'directories are not files');
  } finally { await h.close(); }
});

test('--root confines the file APIs, symlinks included; uploads stay viewable', async () => {
  const { setRoot } = await import('../src/files.js'); const { createHatch } = await import('../src/server.js');
  const base = tmp(); const root = path.join(base, 'proj'); const outside = path.join(base, 'secret'); fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'in.txt'), 'ok'); fs.writeFileSync(path.join(outside, 'out.txt'), 'nope'); fs.symlinkSync(outside, path.join(root, 'link'));
  const hatch = createHatch({ stateDir: path.join(base, '.hatch'), host: '127.0.0.1', port: 0, attach: ['cat'], cwd: root, root }); const port = await hatch.listen();
  const call = async (m, r, b) => { const x = await fetch(`http://127.0.0.1:${port}${r}`, { method: m, headers: { 'x-token': hatch.token, ...(b && { 'content-type': 'application/json' }) }, body: b && JSON.stringify(b) }); return { status: x.status, data: await x.json().catch(() => null) }; };
  try {
    const q = (p) => encodeURIComponent(p);
    assert.equal((await call('GET', `/api/fs/read?path=${q(path.join(root, 'in.txt'))}`)).status, 200);
    assert.equal((await call('GET', `/api/fs/read?path=${q(path.join(outside, 'out.txt'))}`)).status, 403);
    assert.equal((await call('GET', `/api/fs/read?path=${q(path.join(root, 'link', 'out.txt'))}`)).status, 403, 'symlink out of the root');
    assert.equal((await call('GET', `/api/fs/list?path=${q(base)}`)).status, 403);
    assert.equal((await call('GET', `/api/fs/read?path=${q(path.join(root, '..', 'secret', 'out.txt'))}`)).status, 403, 'dot-dot');
    assert.equal((await call('PUT', '/api/fs/write', { path: path.join(outside, 'new.txt'), text: 'x' })).status, 403);
    assert.equal((await call('PUT', '/api/fs/write', { path: path.join(root, 'new.txt'), text: 'x' })).status, 200);
    assert.equal((await call('PUT', '/api/fs/write', { path: path.join(root, 'link', 'out.txt'), text: 'escape' })).status, 403);
    assert.equal(fs.readFileSync(path.join(outside, 'out.txt'), 'utf8'), 'nope');
    fs.symlinkSync('in.txt', path.join(root, 'alias.txt'));
    assert.equal((await call('PUT', '/api/fs/write', { path: path.join(root, 'alias.txt'), text: 'updated' })).status, 200);
    assert.ok(fs.lstatSync(path.join(root, 'alias.txt')).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(root, 'in.txt'), 'utf8'), 'updated');
    assert.equal((await call('GET', `/api/fs/download?path=${q(path.join(outside, 'out.txt'))}`)).status, 403);
    assert.equal((await call('GET', `/api/file?path=${q(path.join(outside, 'p.png'))}`)).status, 403);
    assert.equal((await call('GET', '/api/info')).data.root, fs.realpathSync(root));
  } finally { await hatch.close(); setRoot(null); }
});

test('file management: new file, folder, rename (no overwrite), delete (empty folders only unless recursive), root protected', async () => {
  const { mkdir, newFile, rename, remove } = await import('../src/files.js');
  const d = tmp(); const p = (n) => path.join(d, n);
  newFile(p('a.txt'), 'x'); assert.throws(() => newFile(p('a.txt')), /already exists/); mkdir(p('sub')); assert.throws(() => mkdir(p('sub')), /already exists/);
  rename(p('a.txt'), p('sub/b.txt')); assert.ok(fs.existsSync(p('sub/b.txt'))); assert.throws(() => rename(p('sub/b.txt'), p('sub/b.txt')), /already exists/);
  assert.throws(() => remove(p('sub')), /not empty/); remove(p('sub/b.txt')); remove(p('sub'));
  assert.equal(fs.existsSync(p('sub')), false); mkdir(p('full')); newFile(p('full/f')); remove(p('full'), true); assert.equal(fs.existsSync(p('full')), false);
  assert.throws(() => remove('/'), /refusing/); assert.throws(() => remove(p('missing')), /no such file/); assert.throws(() => newFile('relative'), /absolute/);
  fs.symlinkSync(d, p('lnk')); remove(p('lnk')); assert.ok(fs.existsSync(d), 'deleting a symlink never deletes its target');
});

test('fs management API respects --root', async () => {
  const { setRoot } = await import('../src/files.js'); const { createHatch } = await import('../src/server.js');
  const base = tmp(); const root = path.join(base, 'proj'); fs.mkdirSync(root);
  const hatch = createHatch({ stateDir: path.join(base, '.hatch'), host: '127.0.0.1', port: 0, attach: ['cat'], cwd: root, root }); const port = await hatch.listen();
  const call = async (r, b) => { const x = await fetch(`http://127.0.0.1:${port}${r}`, { method: 'POST', headers: { 'x-token': hatch.token, 'content-type': 'application/json' }, body: JSON.stringify(b) }); return x.status; };
  try {
    assert.equal(await call('/api/fs/newfile', { path: path.join(root, 'ok.txt') }), 200); assert.equal(await call('/api/fs/newfile', { path: path.join(base, 'out.txt') }), 403);
    assert.equal(await call('/api/fs/rename', { from: path.join(root, 'ok.txt'), to: path.join(base, 'moved.txt') }), 403);
    assert.equal(await call('/api/fs/delete', { path: root }), 400); assert.equal(await call('/api/fs/mkdir', { path: path.join(root, 'd') }), 200);
  } finally { await hatch.close(); setRoot(null); }
});

test('text saves preserve symlinks and refuse deleted files, precise conflicts and invalid timestamps', () => {
  const d = tmp(); const file = path.join(d, 'target.sh'); const link = path.join(d, 'link.sh'); const chain = path.join(d, 'chain.sh');
  try {
    fs.writeFileSync(file, 'original', { mode: 0o751 }); fs.symlinkSync('target.sh', link); fs.symlinkSync('link.sh', chain);
    const opened = readText(chain); const saved = writeText(chain, 'updated', opened.mtime);
    assert.equal(saved.path, chain); assert.equal(fs.readFileSync(file, 'utf8'), 'updated');
    assert.equal(fs.readlinkSync(link), 'target.sh'); assert.equal(fs.readlinkSync(chain), 'link.sh');
    assert.equal(fs.statSync(file).mode & 0o777, 0o751);
    for (const mtime of [null, '', String(saved.mtime), {}, [], NaN, Infinity]) {
      assert.throws(() => writeText(chain, 'invalid', mtime), e => e.status === 400);
      assert.equal(fs.readFileSync(file, 'utf8'), 'updated');
    }
    fs.utimesSync(file, 1700000000, 1700000000.0005);
    const precise = readText(file);
    assert.throws(() => writeText(file, 'stale', precise.mtime - 0.25), e => e.status === 409);
    fs.unlinkSync(file);
    assert.throws(() => writeText(chain, 'deleted', saved.mtime), e => e.status === 409);
    assert.throws(() => writeText(file, 'deleted', saved.mtime), e => e.status === 409);
    assert.throws(() => writeText(chain, 'dangling'), e => e.status === 404);
    assert.ok(fs.lstatSync(chain).isSymbolicLink()); assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.ok(!fs.existsSync(file)); assert.equal(writeText(file, 'explicit creation').size, 17);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('file write API preserves symlinks, reports deleted-file conflicts and rejects malformed mtimes', async () => {
  const h = await startHatch();
  try {
    const file = path.join(h.dir, 'real.txt'); const link = path.join(h.dir, 'alias.txt');
    fs.writeFileSync(file, 'before'); fs.symlinkSync('real.txt', link);
    const opened = (await h.call('GET', `/api/fs/read?path=${encodeURIComponent(link)}`)).data;
    assert.equal((await h.call('PUT', '/api/fs/write', { path: link, text: 'after', mtime: opened.mtime })).status, 200);
    assert.ok(fs.lstatSync(link).isSymbolicLink()); assert.equal(fs.readFileSync(file, 'utf8'), 'after');
    assert.equal((await h.call('PUT', '/api/fs/write', { path: link, text: 'bad', mtime: {} })).status, 400);
    fs.unlinkSync(file);
    assert.equal((await h.call('PUT', '/api/fs/write', { path: link, text: 'bad', mtime: opened.mtime })).status, 409);
    assert.equal((await h.call('PUT', '/api/fs/write', { path: link, text: 'bad' })).status, 404);
    assert.ok(fs.lstatSync(link).isSymbolicLink()); assert.ok(!fs.existsSync(file));
  } finally { await h.close(); }
});
