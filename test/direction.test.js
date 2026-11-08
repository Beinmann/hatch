import test from 'node:test';
import assert from 'node:assert/strict';
import { pickDirection, step, listStep } from '../public/direction.js';

const it = (id, x, y) => ({ id, x, y });
// overlapping, non-aligned windows plus the terminal
const items = [it('term', 400, 300), it('a', 100, 80), it('b', 180, 200), it('c', 120, 330), it('d', 300, 450), it('e', 310, 440)];

test('pickDirection is deterministic and ignores empty or same-side windows', () => {
  assert.equal(pickDirection(items, 'a', 'j'), 'b');
  assert.equal(pickDirection(items, 'a', 'k'), null);
  assert.equal(pickDirection([it('x', 0, 0), it('z', 0, 100), it('y', 0, 100)], 'x', 'j'), 'y', 'ties go to the lowest id');
  assert.equal(pickDirection([it('x', 0, 0), { id: 'e', x: 0, y: 50, empty: true }], 'x', 'j'), null);
});

test('pressing j to the end then k visits the same windows in reverse', () => {
  for (const start of items.map((i) => i.id)) {
    let trail = []; let cur = start; const down = [start];
    for (;;) { const r = step(trail, items, cur, 'j'); if (!r.id) break; trail = r.trail; cur = r.id; down.push(cur); }
    const up = [cur];
    for (let i = 0; i < down.length - 1; i++) { const r = step(trail, items, cur, 'k'); assert.ok(r.id, `k from ${cur}`); trail = r.trail; cur = r.id; up.push(cur); }
    assert.deepEqual(up, [...down].reverse(), `start ${start}`);
  }
});

test('a stale trail (focus moved by other means) is ignored', () => {
  const r = step([{ from: 'a', to: 'b', dir: 'j' }], items, 'c', 'k');
  assert.equal(r.id, pickDirection(items, 'c', 'k'));
});

test('picker h/l fallback reaches an off-screen chip instead of looping between on-screen windows', () => {
  const ids = ['clock', 'calc', 'ports']; const off = ['ports'];
  assert.equal(listStep(ids, off, 'clock', 'l'), 'ports');
  assert.equal(listStep(ids, off, 'calc', 'l'), 'ports');
  assert.equal(listStep(ids, off, 'ports', 'l'), 'clock');
  assert.equal(listStep(ids, off, 'ports', 'h'), 'calc');
  assert.equal(listStep(ids, off, 'clock', 'h'), 'ports');
  assert.equal(listStep(['a', 'b'], [], 'a', 'l'), 'b', 'nothing off screen: plain list wrap');
});
