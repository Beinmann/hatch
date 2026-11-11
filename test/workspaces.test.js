import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, PNG, startHatch, readSse, waitFor } from './helpers.js';
import { migrate, readRegistry, importState, createWorkspace, BACKUP_DIR } from '../src/workspaces.js';

const panel = (dir, id, extra = {}) => { fs.mkdirSync(path.join(dir, 'panels'), { recursive: true }); fs.writeFileSync(path.join(dir, 'panels', `${id}.json`), JSON.stringify({ type: 'note', title: id, props: { markdown: 'x' }, ...extra })); };

test('migration wraps the existing layout and background as main and keeps a backup', () => {
  const dir = tmp();
  panel(dir, 'p1', { x: 10, y: 20 }); panel(dir, 'p2', { ws: 'old' });
  fs.writeFileSync(path.join(dir, 'background.png'), PNG); fs.writeFileSync(path.join(dir, 'background.json'), '{"mode":"fit"}');
  const before = fs.readFileSync(path.join(dir, 'panels', 'p1.json'), 'utf8');
  const r = migrate(dir);
  assert.equal(r.migrated, true);
  assert.deepEqual(r.workspaces, ['main', 'old']);
  assert.equal(fs.readFileSync(path.join(dir, 'panels', 'p1.json'), 'utf8'), before, 'windows are not rewritten');
  assert.ok(fs.existsSync(path.join(dir, 'background.png')), 'main keeps the state dir background');
  assert.equal(fs.readFileSync(path.join(dir, BACKUP_DIR, 'background.png')).length, PNG.length);
  assert.ok(fs.existsSync(path.join(dir, BACKUP_DIR, 'panels', 'p1.json')));
  const old = readRegistry(dir).list.find((w) => w.name === 'old');
  assert.ok(fs.existsSync(path.join(dir, 'workspaces', old.id, 'background.png')), 'an older virtual desktop keeps the look it had');
  assert.equal(migrate(dir).migrated, false, 'second start does nothing');
});

test('migration of an empty state dir makes no backup', () => {
  const dir = tmp();
  assert.equal(migrate(dir).backup, undefined);
  assert.deepEqual(readRegistry(dir).list.map((w) => w.name), ['main']);
});

test('workspace API: create, background per workspace, switch events, rename, close needs the exact name', async () => {
  const h = await startHatch();
  try {
    fs.writeFileSync(path.join(h.stateDir, 'background.png'), PNG);
    const w = (await h.call('POST', '/api/workspaces', { name: 'work' })).data;
    assert.equal((await h.call('POST', '/api/workspaces', { name: 'WORK' })).status, 409);
    assert.equal((await h.call('POST', '/api/workspaces', { name: 'bad name' })).status, 400);
    assert.equal((await h.call('PUT', `/api/workspaces/work/background`, PNG)).status, 200);
    await waitFor(async () => (await h.call('GET', '/api/workspaces')).data.find((x) => x.name === 'work')?.background);
    const list = (await h.call('GET', '/api/workspaces')).data;
    assert.deepEqual(list.map((x) => x.name), ['main', 'work']);
    assert.ok(list[0].background && list[1].background);
    assert.equal((await h.call('GET', '/background/image?ws=work')).status, 200);
    assert.equal((await h.call('GET', '/background/image?ws=nope')).status, 404);
    // windows and a terminal window in work
    await h.call('POST', '/api/panels', { type: 'note', title: 'n', props: { markdown: 'a' }, ws: 'work' });
    const t = (await h.call('POST', '/api/panels', { type: 'terminal', title: 't', props: { name: 'wt' }, ws: 'work' })).data;
    await h.call('POST', '/api/pterm/wt', {});
    // move a window to main: same id, terminal still known
    assert.equal((await h.call('PATCH', `/api/panels/${t.id}`, { ws: 'main' })).data.ws, undefined);
    assert.equal((await h.call('GET', '/api/pterm/wt/alive')).data.alive, true);
    await h.call('PATCH', `/api/panels/${t.id}`, { ws: 'work' });
    // rename keeps windows and id
    assert.equal((await h.call('POST', '/api/workspaces/work/rename', { to: 'job' })).status, 200);
    assert.ok((await h.call('GET', '/api/panels')).data.every((p) => p.ws === 'job'));
    assert.equal((await h.call('GET', '/api/workspaces')).data.find((x) => x.name === 'job').id, w.id);
    // close: refused without the exact name
    assert.equal((await h.call('DELETE', '/api/workspaces/job', {})).status, 400);
    assert.equal((await h.call('DELETE', '/api/workspaces/job', { confirm: 'jo' })).status, 400);
    assert.equal((await h.call('DELETE', '/api/workspaces/main', { confirm: 'main' })).status, 400);
    assert.equal((await h.call('GET', '/api/workspaces')).data.length, 2);
    const r = await h.call('DELETE', '/api/workspaces/job', { confirm: 'job' });
    assert.equal(r.status, 200); assert.equal(r.data.closedWindows, 2);
    assert.equal((await h.call('GET', '/api/panels')).data.length, 0);
    assert.equal((await h.call('GET', '/api/pterm/wt/alive')).data.alive, false, 'the terminal of a closed workspace is gone');
    assert.equal(fs.existsSync(path.join(h.stateDir, 'workspaces', w.id)), false);
  } finally { await h.close(); }
});

test('snapshot carries workspaces, per-workspace backgrounds and tab presence', async () => {
  const h = await startHatch();
  try {
    await h.call('POST', '/api/workspaces', { name: 'work' });
    const open = (cid) => { const ctl = new AbortController(); fetch(`${h.base}/api/events?cid=${cid}`, { headers: { 'x-token': h.hatch.token }, signal: ctl.signal }).catch(() => {}); return ctl; };
    const a = open('tab-a'); const b = open('tab-b');
    await waitFor(async () => (await h.call('POST', '/api/presence', { cid: 'tab-a', ws: 'work' })).status === 200);
    await waitFor(async () => (await h.call('POST', '/api/presence', { cid: 'tab-b', ws: 'work' })).data?.counts?.work === 2);
    const events = await readSse(`${h.base}/api/events?cid=tab-c`, { 'x-token': h.hatch.token }, (e) => e.some((x) => x.event === 'snapshot'));
    const snap = JSON.parse(events.find((x) => x.event === 'snapshot').data);
    assert.deepEqual(snap.workspaces.map((x) => x.name), ['main', 'work']);
    assert.equal(snap.presence.work, 2);
    assert.equal((await h.call('POST', '/api/presence', { cid: 'nope', ws: 'work' })).status, 400);
    a.abort(); b.abort();
  } finally { await h.close(); }
});

test('import folds another state dir into a workspace', () => {
  const dir = tmp(); const src = tmp();
  migrate(dir);
  panel(src, 'p1', { x: 5 }); panel(src, 'p2', { type: 'terminal', props: { name: 'sh' } });
  fs.writeFileSync(path.join(src, 'panels', 'p2.json'), JSON.stringify({ type: 'terminal', title: 't', props: { name: 'sh' } }));
  fs.writeFileSync(path.join(src, 'background.png'), PNG);
  panel(dir, 'p1'); createWorkspace(dir, 'other');
  const r = importState(dir, src, 'folded');
  assert.equal(r.created, true); assert.equal(r.windows, 2);
  const files = fs.readdirSync(path.join(dir, 'panels')).sort();
  assert.deepEqual(files, ['p1.json', 'p2.json', 'p3.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'panels', 'p2.json'), 'utf8')).ws, 'folded');
  const id = readRegistry(dir).list.find((w) => w.name === 'folded').id;
  assert.ok(fs.existsSync(path.join(dir, 'workspaces', id, 'background.png')));
  assert.throws(() => importState(dir, tmp(), 'x'), /does not look like a Hatch state dir/);
});

test('hatch workspace CLI: new, list, set background --ws, close needs --confirm', async () => {
  const { spawn } = await import('node:child_process');
  const UI = new URL('../bin/hatch.js', import.meta.url).pathname;
  const ui = (args, state) => new Promise((resolve) => {
    const p = spawn('node', [UI, '--state', state, ...args], { env: { ...process.env, HATCH_STATE: '' } });
    let stdout = ''; let stderr = ''; p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const h = await startHatch();
  try {
    let r = await ui(['workspace', 'new', 'work'], h.stateDir); assert.equal(r.status, 0, r.stderr);
    const png = path.join(h.dir, 'b.png'); fs.writeFileSync(png, PNG);
    r = await ui(['set', 'background', png, '--ws', 'work'], h.stateDir); assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(path.join(h.stateDir, 'background.png')), false, 'main is untouched');
    await waitFor(async () => (await h.call('GET', '/api/workspaces')).data.find((w) => w.name === 'work').background);
    r = await ui(['workspace', 'list'], h.stateDir); assert.match(r.stdout, /work .*background/);
    r = await ui(['workspace', 'close', 'work'], h.stateDir); assert.equal(r.status, 1); assert.match(r.stderr, /--confirm work/);
    r = await ui(['workspace', 'close', 'work', '--confirm', 'work'], h.stateDir); assert.equal(r.status, 0, r.stderr);
    assert.equal((await h.call('GET', '/api/workspaces')).data.length, 1);
  } finally { await h.close(); }
});
