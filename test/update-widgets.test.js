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
