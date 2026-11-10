import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateWidgets } from '../src/update-widgets.js';

test('update-widgets replaces widget files, keeps data/, backs up local edits, skips unused widgets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-uw-'));
  const w = path.join(dir, 'widgets', 'background-roulette');
  fs.mkdirSync(path.join(w, 'data'), { recursive: true });
  fs.writeFileSync(path.join(w, 'index.html'), 'old');
  fs.writeFileSync(path.join(w, 'data', 'a.jpg'), 'img');
  const r = updateWidgets(dir, null);
  assert.deepEqual(r.updated.map((u) => u.name), ['background-roulette']);
  assert.ok(r.missing.includes('clock'));
  assert.notEqual(fs.readFileSync(path.join(w, 'index.html'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(w, 'index.html.bak'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(w, 'data', 'a.jpg'), 'utf8'), 'img');
  assert.deepEqual(updateWidgets(dir, ['background-roulette']).unchanged, ['background-roulette']);
  assert.throws(() => updateWidgets(dir, ['nope']), /no example widget nope/);
});

test('stale check: recorded hash, edits, no record, and the /api/examples hint', async () => {
  const { widgetStatus, recordShipped, shippedHash } = await import('../src/update-widgets.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-uw-')); const w = path.join(dir, 'widgets', 'clock');
  assert.equal(widgetStatus(dir, 'clock'), 'unknown', 'not installed');
  fs.cpSync(new URL('../examples/widgets/clock', import.meta.url), w, { recursive: true });
  assert.equal(widgetStatus(dir, 'clock'), 'current'); assert.ok(fs.existsSync(path.join(dir, 'shipped-widgets.json')), 'an identical copy gets recorded');
  // edited on purpose, shipped unchanged: no warning
  fs.appendFileSync(path.join(w, 'index.html'), '\n<!-- mine -->'); assert.equal(widgetStatus(dir, 'clock'), 'current');
  // upstream moved (simulated by a record of an older shipped version): warns, edited or not
  const rec = path.join(dir, 'shipped-widgets.json'); fs.writeFileSync(rec, JSON.stringify({ clock: 'old' })); assert.equal(widgetStatus(dir, 'clock'), 'stale');
  // refreshing records the new version and clears the warning
  updateWidgets(dir, ['clock']); assert.equal(widgetStatus(dir, 'clock'), 'current'); assert.equal(JSON.parse(fs.readFileSync(rec, 'utf8')).clock, shippedHash('clock'));
  // no record: an untouched old copy is stale, a copy edited later is unknown (we cannot tell), a malformed record is ignored
  fs.rmSync(rec); fs.writeFileSync(path.join(w, 'index.html'), 'old shipped version'); const old = new Date(Date.now() - 3600e3);
  fs.utimesSync(path.join(w, 'widget.json'), old, old); fs.utimesSync(path.join(w, 'index.html'), new Date(), new Date());
  assert.equal(widgetStatus(dir, 'clock'), 'unknown');
  fs.utimesSync(path.join(w, 'index.html'), old, old); assert.equal(widgetStatus(dir, 'clock'), 'stale');
  fs.writeFileSync(rec, '{not json'); assert.equal(widgetStatus(dir, 'clock'), 'stale');
  recordShipped(dir, 'clock'); assert.equal(JSON.parse(fs.readFileSync(rec, 'utf8')).clock, shippedHash('clock'), 'recording over a malformed file works');
});

test('opening an example records its hash; /api/examples flags only a stale installed copy', async () => {
  const { startHatch } = await import('./helpers.js');
  const h = await startHatch();
  try {
    assert.equal((await h.call('POST', '/api/examples/clock/open', {})).status, 200);
    const rec = path.join(h.stateDir, 'shipped-widgets.json'); assert.ok(JSON.parse(fs.readFileSync(rec, 'utf8')).clock);
    let list = (await h.call('GET', '/api/examples')).data; assert.equal(list.find((e) => e.name === 'clock').stale, undefined);
    fs.appendFileSync(path.join(h.stateDir, 'widgets/clock/index.html'), '\n<!-- old copy -->'); fs.writeFileSync(rec, JSON.stringify({ clock: 'older' }));
    list = (await h.call('GET', '/api/examples')).data;
    assert.equal(list.find((e) => e.name === 'clock').stale, true); assert.match(list.find((e) => e.name === 'clock').hint, /hatch-server update-widgets clock/);
    assert.equal(list.find((e) => e.name === 'cpu').stale, undefined, 'a widget this instance never copied is not flagged');
  } finally { await h.close(); }
});
