import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startHatch } from './helpers.js';
import { updateWidgets } from '../src/update-widgets.js';

const open = (h, name, ws) => h.call('POST', '/api/panels', { type: 'widget', props: { name }, ...(ws && { ws }) });
const wins = async (h) => (await h.call('GET', '/api/panels')).data.filter((p) => p.type === 'widget');

test('a widget open in another workspace is copied there, the first window is untouched', async () => {
  const h = await startHatch({ attach: null });
  try {
    for (const n of ['a', 'b']) await h.call('POST', '/api/workspaces', { name: n });
    const first = (await h.call('POST', '/api/examples/clock/open', { ws: 'a' })).data;
    await h.call('PATCH', `/api/panels/${first.id}`, { folder: 'fa', x: 123, w: 321 });
    const before = (await h.call('GET', `/api/panels/${first.id}`)).data;
    const second = (await h.call('POST', '/api/examples/clock/open', { ws: 'b' })).data;
    assert.notEqual(second.id, first.id);
    assert.equal(second.ws, 'b'); assert.equal(second.folder, undefined); assert.equal(second.props.name, 'clock-b');
    assert.equal(second.title, before.title, 'title stays the original widget title');
    assert.deepEqual((await h.call('GET', `/api/panels/${first.id}`)).data, before);
    const meta = JSON.parse(fs.readFileSync(path.join(h.stateDir, 'widgets', 'clock-b', 'widget.json'), 'utf8'));
    assert.equal(meta.copyOf, 'clock');
    assert.ok(fs.existsSync(path.join(h.stateDir, 'widgets', 'clock-b', 'index.html')));
    // same workspace again (by either name): reuse, no third window
    assert.equal((await open(h, 'clock', 'b')).data.id, second.id);
    assert.equal((await open(h, 'clock', 'a')).data.id, first.id);
    assert.equal((await wins(h)).length, 2);
    // closing B's window leaves A alone; the copy folder stays; opening again reuses the copy
    await h.call('DELETE', `/api/panels/${second.id}`);
    assert.equal((await h.call('GET', `/api/panels/${first.id}`)).data.ws, 'a');
    assert.ok(fs.existsSync(path.join(h.stateDir, 'widgets', 'clock-b')));
    assert.equal((await open(h, 'clock', 'b')).data.props.name, 'clock-b');
    // a taken name gets a number
    fs.mkdirSync(path.join(h.stateDir, 'widgets', 'clock-c'));
    await h.call('POST', '/api/workspaces', { name: 'c' });
    assert.equal((await open(h, 'clock', 'c')).data.props.name, 'clock-c-2');
  } finally { await h.close(); }
});

test('the copy starts with an empty data folder', async () => {
  const h = await startHatch({ attach: null });
  try {
    await h.call('POST', '/api/workspaces', { name: 'a' });
    await h.call('POST', '/api/examples/clock/open', {});
    fs.mkdirSync(path.join(h.stateDir, 'widgets', 'clock', 'data'), { recursive: true });
    fs.writeFileSync(path.join(h.stateDir, 'widgets', 'clock', 'data', 'x.txt'), 'private');
    const c = (await open(h, 'clock', 'a')).data;
    assert.equal(c.props.name, 'clock-a');
    assert.ok(!fs.existsSync(path.join(h.stateDir, 'widgets', 'clock-a', 'data')));
  } finally { await h.close(); }
});

test('a sticky window is visible everywhere: no copy', async () => {
  const h = await startHatch({ attach: null });
  try {
    await h.call('POST', '/api/workspaces', { name: 'a' });
    const w = (await open(h, 'clock')).data; await h.call('PATCH', `/api/panels/${w.id}`, { sticky: true });
    assert.equal((await open(h, 'clock', 'a')).data.id, w.id);
    assert.equal((await wins(h)).length, 1);
  } finally { await h.close(); }
});

test('ws cannot be patched on an existing window', async () => {
  const h = await startHatch({ attach: null });
  try {
    await h.call('POST', '/api/workspaces', { name: 'a' });
    const w = (await open(h, 'clock')).data;
    assert.equal((await h.call('PATCH', `/api/panels/${w.id}`, { ws: 'a' })).status, 400);
    assert.equal((await h.call('GET', `/api/panels/${w.id}`)).data.ws, undefined);
  } finally { await h.close(); }
});

test('a terminal re-opened in another workspace does not carry its folder', async () => {
  const h = await startHatch({ attach: null });
  try {
    await h.call('POST', '/api/workspaces', { name: 'a' });
    const t = (await h.call('POST', '/api/panels', { type: 'terminal', props: { name: 'tt' }, ws: 'a' })).data;
    await h.call('PATCH', `/api/panels/${t.id}`, { folder: 'fa' });
    const r = (await h.call('POST', '/api/panels', { type: 'terminal', props: { name: 'tt' } })).data;
    assert.equal(r.folder, undefined);
  } finally { await h.close(); }
});

test('update-widgets refreshes per-workspace copies from the original, keeping title and size', async () => {
  const h = await startHatch({ attach: null });
  try {
    await h.call('POST', '/api/workspaces', { name: 'a' });
    await h.call('POST', '/api/examples/clock/open', {}); await open(h, 'clock', 'a');
    const dir = path.join(h.stateDir, 'widgets', 'clock-a');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'widget.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'widget.json'), JSON.stringify({ ...meta, title: 'Mine', w: 111 }));
    fs.writeFileSync(path.join(dir, 'index.html'), 'old');
    const r = updateWidgets(h.stateDir, ['clock-a']);
    assert.deepEqual(r.updated.map((u) => u.name), ['clock-a']);
    assert.notEqual(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(dir, 'index.html.bak'), 'utf8'), 'old');
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'widget.json'), 'utf8'));
    assert.equal(after.title, 'Mine'); assert.equal(after.w, 111); assert.equal(after.copyOf, 'clock');
    fs.writeFileSync(path.join(dir, 'index.html'), 'old2');
    assert.ok(updateWidgets(h.stateDir, ['clock']).updated.some((u) => u.name === 'clock-a')); // along with the original
    assert.ok(updateWidgets(h.stateDir, null).unchanged.includes('clock-a'));
  } finally { await h.close(); }
});
