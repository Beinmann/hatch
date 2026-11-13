import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHatch, tmp } from './helpers.js';
import { groupWindows, freeFolderName, resolveWindow, folderOf, folderNameProblem, deletePatches, renamePatches } from '../public/folders.js';

const P = (id, o = {}) => ({ id, title: id.toUpperCase(), type: 'note', ...o });

test('groupWindows: folders sorted, loose kept in order, other workspaces and bad names ignored', () => {
  const ps = [P('a'), P('b', { folder: 'Zed' }), P('c', { folder: 'Alpha' }), P('d', { folder: 'Zed' }), P('e', { ws: 'x', folder: 'Alpha' }), P('f', { folder: 'no/slash' }), P('g', { ws: 'x', sticky: true, folder: 'Alpha' })];
  assert.deepEqual(groupWindows(ps, 'main'), { folders: [{ name: 'Alpha', ids: ['c', 'g'] }, { name: 'Zed', ids: ['b', 'd'] }], loose: ['a', 'f'] });
  assert.deepEqual(groupWindows(ps, 'x'), { folders: [{ name: 'Alpha', ids: ['e', 'g'] }], loose: [] });
  assert.equal(folderOf(P('q', { folder: 5 })), null);
});

test('freeFolderName, folderNameProblem, patches', () => {
  const ps = [P('a', { folder: 'Folder' }), P('b', { folder: 'Folder-2' }), P('c', { ws: 'x', folder: 'Other' })];
  assert.equal(freeFolderName(ps, 'main'), 'Folder-3');
  assert.equal(freeFolderName(ps, 'x'), 'Folder');
  assert.equal(folderNameProblem('ok-1'), null);
  assert.ok(folderNameProblem('a/b')); assert.ok(folderNameProblem('')); assert.ok(folderNameProblem(' x'));
  assert.deepEqual(deletePatches(ps, 'main', 'Folder'), [{ id: 'a', folder: null }]);
  assert.deepEqual(renamePatches(ps, 'main', 'Folder', 'New'), [{ id: 'a', folder: 'New' }]);
  assert.deepEqual(deletePatches(ps, 'main', 'Nope'), []);
});

test('resolveWindow: id, widget name, unique title; clear errors', () => {
  const ps = [P('p1', { title: 'Notes' }), P('w-git', { type: 'widget', title: 'Git' }), P('p2', { title: 'Dup' }), P('p3', { title: 'Dup' }), P('p4', { ws: 'x', title: 'Far' })];
  assert.equal(resolveWindow(ps, 'main', 'p1').id, 'p1');
  assert.equal(resolveWindow(ps, 'main', 'git').id, 'w-git');
  assert.equal(resolveWindow(ps, 'main', 'Notes').id, 'p1');
  assert.throws(() => resolveWindow(ps, 'main', 'Dup'), /2 windows/);
  assert.throws(() => resolveWindow(ps, 'main', 'p4'), /no window/);
  assert.equal(resolveWindow(ps, 'x', 'p4').id, 'p4');
});

test('server: folder is saved in the window file, validated, cleared with null; hand edit works, bad value ignored', async () => {
  const h = await startHatch();
  try {
    const p = (await h.call('POST', '/api/panels', { type: 'note', props: { markdown: 'x' } })).data;
    let r = (await h.call('PATCH', `/api/panels/${p.id}`, { folder: 'Work' })).data;
    assert.equal(r.folder, 'Work');
    const file = path.join(h.stateDir, 'panels', `${p.id}.json`);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).folder, 'Work');
    const bad = await h.call('PATCH', `/api/panels/${p.id}`, { folder: 'a/b' });
    assert.equal(bad.status, 400); assert.match(bad.data.error, /folder must be/);
    r = (await h.call('PATCH', `/api/panels/${p.id}`, { minimized: true })).data;
    assert.equal(r.folder, 'Work'); assert.equal(r.minimized, true);
    r = (await h.call('PATCH', `/api/panels/${p.id}`, { folder: null })).data;
    assert.equal(r.folder, undefined);
    assert.equal('folder' in JSON.parse(fs.readFileSync(file, 'utf8')), false);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.folder = 42; fs.writeFileSync(file, JSON.stringify(raw));
    const list = (await h.call('GET', '/api/panels')).data; // a hand-edited bad value must not break the window or the server
    assert.equal(list.find((x) => x.id === p.id).folder, undefined);
  } finally { await h.close(); }
});

const UI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
const FAKE_HOME = tmp();
const ui = (args, state, env = {}) => new Promise((resolve) => {
  const p = spawn('node', [UI, '--state', state, ...args], { env: { ...process.env, HOME: FAKE_HOME, HATCH_STATE: '', HATCH_WORKSPACE: '', ...env } });
  let stdout = ''; let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => resolve({ status, stdout, stderr })); p.stdin.end();
});

test('CLI: folder new / add / list / remove / rename / delete, per workspace', async () => {
  const h = await startHatch(); const s = h.stateDir;
  try {
    const a = (await h.call('POST', '/api/panels', { type: 'note', title: 'Alpha', props: { markdown: 'a' } })).data;
    const b = (await h.call('POST', '/api/panels', { type: 'note', title: 'Beta', props: { markdown: 'b' } })).data;
    const c = (await h.call('POST', '/api/panels', { type: 'note', title: 'Gamma', ws: 'other', props: { markdown: 'c' } })).data;
    let r = await ui(['folder', 'list'], s); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /no folders/);
    r = await ui(['folder', 'new', 'Work', a.id, 'Beta'], s); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /2 windows/);
    r = await ui(['folder', 'list', '--json'], s);
    assert.deepEqual(JSON.parse(r.stdout).map((f) => [f.name, f.windows.map((w) => w.id)]), [['Work', [a.id, b.id]]]);
    r = await ui(['folder', 'new', 'Work', a.id], s); assert.equal(r.status, 1); assert.match(r.stderr, /already exists/);
    r = await ui(['folder', 'add', 'Nope', a.id], s); assert.equal(r.status, 1);
    r = await ui(['folder', 'new', 'bad/name', a.id], s); assert.equal(r.status, 1); assert.match(r.stderr, /letters, digits/);
    r = await ui(['folder', 'add', 'Work', c.id], s); assert.equal(r.status, 1); assert.match(r.stderr, /no window/); // other workspace
    r = await ui(['folder', 'list'], s, { HATCH_WORKSPACE: 'other' }); assert.match(r.stdout, /no folders/);
    r = await ui(['folder', 'add', 'Work', c.id], s, { HATCH_WORKSPACE: 'other' }); assert.equal(r.status, 1); assert.match(r.stderr, /no folder Work/);
    r = await ui(['folder', 'remove', 'Beta'], s); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /1 window/);
    r = await ui(['folder', 'rename', 'Work', 'Play'], s); assert.equal(r.status, 0, r.stderr);
    assert.equal(((await h.call('GET', `/api/panels/${a.id}`)).data).folder, 'Play');
    r = await ui(['folder', 'delete', 'Play'], s); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /1 window/);
    assert.equal(((await h.call('GET', `/api/panels/${a.id}`)).data).folder, undefined);
    r = await ui(['folder', 'delete', 'Play'], s); assert.equal(r.status, 1);
    r = await ui(['folder', 'bogus'], s); assert.equal(r.status, 1); assert.match(r.stderr, /usage: folder/);
  } finally { await h.close(); }
});
