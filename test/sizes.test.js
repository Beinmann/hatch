import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startHatch } from './helpers.js';

const open = (call, body) => call('POST', '/api/panels', { type: 'iframe', props: { url: 'http://x' }, ...body });

test('default size when nothing is remembered', async () => {
  const t = await startHatch();
  try {
    const { data } = await open(t.call);
    assert.deepEqual([data.w, data.h], [640, 420]);
  } finally { await t.close(); }
});

test('a deliberate resize is remembered for that kind; an explicit size wins', async () => {
  const t = await startHatch();
  try {
    const a = (await open(t.call)).data;
    assert.equal((await t.call('PATCH', `/api/panels/${a.id}`, { w: 700, h: 500, remember: true })).status, 200);
    const saved = JSON.parse(fs.readFileSync(path.join(t.stateDir, 'sizes.json'), 'utf8'));
    assert.deepEqual(saved.iframe, { w: 700, h: 500 });
    const b = (await open(t.call)).data;
    assert.deepEqual([b.w, b.h], [700, 500]);
    const c = (await open(t.call, { w: 300, h: 200 })).data;
    assert.deepEqual([c.w, c.h], [300, 200]);
    const note = (await t.call('POST', '/api/panels', { type: 'note', props: { markdown: 'x' } })).data;
    assert.deepEqual([note.w, note.h], [360, 240], 'other kinds keep their default');
  } finally { await t.close(); }
});

test('a resize without remember (tiling, maximize) is not remembered', async () => {
  const t = await startHatch();
  try {
    const a = (await open(t.call)).data;
    await t.call('PATCH', `/api/panels/${a.id}`, { w: 900, h: 600 });
    assert.equal(fs.existsSync(path.join(t.stateDir, 'sizes.json')), false);
    assert.equal((await open(t.call)).data.w, 640);
  } finally { await t.close(); }
});

test('widgets and output kinds are remembered separately; docked windows remember only a height', async () => {
  const t = await startHatch();
  try {
    const d = (await t.call('POST', '/api/panels', { type: 'output', props: { cmd: 'git diff', kind: 'diff' } })).data;
    assert.deepEqual([d.w, d.h], [680, 360]);
    await t.call('PATCH', `/api/panels/${d.id}`, { w: 800, h: 450, remember: true });
    assert.equal((await t.call('POST', '/api/panels', { type: 'output', props: { cmd: 'ls' } })).data.w, 560);
    assert.equal((await t.call('POST', '/api/panels', { type: 'output', props: { cmd: 'git diff', kind: 'diff' } })).data.w, 800);
    const p = (await t.call('POST', '/api/panels', { type: 'git', props: { dir: '/' }, placement: 'dock' })).data;
    await t.call('PATCH', `/api/panels/${p.id}`, { h: 333, remember: true });
    const saved = JSON.parse(fs.readFileSync(path.join(t.stateDir, 'sizes.json'), 'utf8'));
    assert.deepEqual(saved.git, { dockH: 333 });
    const f = (await t.call('POST', '/api/panels', { type: 'git', props: { dir: '/' } })).data;
    assert.deepEqual([f.w, f.h], [420, 420], 'the floating size is separate from the dock height');
  } finally { await t.close(); }
});

test('a broken sizes.json warns and falls back to defaults; deleting it works', async () => {
  const t = await startHatch();
  try {
    fs.writeFileSync(path.join(t.stateDir, 'sizes.json'), '{ nope');
    const a = (await open(t.call)).data;
    assert.equal(a.w, 640);
    t.hatch.state.rescan();
    assert.ok(t.hatch.state.snapshot().warnings.some((w) => w.file === 'sizes' || /sizes/.test(w.message)));
    fs.writeFileSync(path.join(t.stateDir, 'sizes.json'), JSON.stringify({ iframe: { w: 1, h: 'x' }, note: { w: 500, h: 400 } }));
    assert.equal((await open(t.call)).data.w, 640, 'invalid entries are ignored');
    assert.equal((await t.call('POST', '/api/panels', { type: 'note', props: { markdown: 'x' } })).data.w, 500, 'hand edits work');
    fs.rmSync(path.join(t.stateDir, 'sizes.json'));
    assert.equal((await t.call('POST', '/api/panels', { type: 'note', props: { markdown: 'x' } })).data.w, 360);
  } finally { await t.close(); }
});
