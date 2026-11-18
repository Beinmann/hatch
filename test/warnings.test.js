import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, startHatch } from './helpers.js';
import { collectWarnings, outdatedWidgets, oldToken } from '../src/warnings.js';

const installClock = (dir) => { const w = path.join(dir, 'widgets', 'clock'); fs.cpSync(new URL('../examples/widgets/clock', import.meta.url), w, { recursive: true }); return w; };

test('outdated widgets: current and unused ones are quiet, a copy older than the shipped one is listed with the update command', () => {
  const dir = tmp();
  assert.deepEqual(outdatedWidgets({ stateDir: dir }), [], 'nothing installed');
  installClock(dir);
  assert.deepEqual(outdatedWidgets({ stateDir: dir }), [], 'identical copy');
  fs.appendFileSync(path.join(dir, 'widgets', 'clock', 'index.html'), '\n<!-- old copy -->'); fs.writeFileSync(path.join(dir, 'shipped-widgets.json'), JSON.stringify({ clock: 'older-version' }));
  const [w, ...rest] = outdatedWidgets({ stateDir: dir });
  assert.equal(rest.length, 0);
  assert.deepEqual({ source: w.source, id: w.id, fix: w.fix }, { source: 'widgets', id: 'widget:clock', fix: 'hatch-server update-widgets clock' });
  assert.match(w.message, /clock/);
});

test('old token source, and collectWarnings skips a source that throws', () => {
  const dir = tmp();
  assert.deepEqual(oldToken({ stateDir: dir, now: Date.now() }), [], 'unknown age is never a warning');
  fs.writeFileSync(path.join(dir, 'token-changed'), new Date(Date.now() - 40 * 86400e3).toISOString());
  const [t] = oldToken({ stateDir: dir, now: Date.now() });
  assert.equal(t.source, 'token'); assert.match(t.message, /40 days/); assert.match(t.fix, /rotate-token/);
  const got = collectWarnings({}, [() => { throw new Error('boom'); }, () => [{ source: 's', id: 'x', message: 'm', fix: 'f' }]]);
  assert.deepEqual(got.map((w) => w.id), ['x']);
});

test('GET /api/warnings returns the list', async () => {
  const h = await startHatch();
  try {
    assert.deepEqual((await h.call('GET', '/api/warnings')).data, { warnings: [] });
    fs.appendFileSync(path.join(installClock(h.stateDir), 'index.html'), '\n<!-- old -->'); fs.writeFileSync(path.join(h.stateDir, 'shipped-widgets.json'), JSON.stringify({ clock: 'older-version' }));
    const r = await h.call('GET', '/api/warnings');
    assert.equal(r.status, 200); assert.equal(r.data.warnings[0].fix, 'hatch-server update-widgets clock');
  } finally { await h.close(); }
});
