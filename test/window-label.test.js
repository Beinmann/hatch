import test from 'node:test';
import assert from 'node:assert/strict';
import { windowLabel } from '../public/folder-keys.js';
import { chipSlots } from '../public/taskbar-order.js';

const ids = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i}`);
const W = (...xs) => xs.map((x) => (x === null ? null : { w: x })); // a row of loose windows and open spots
const F = (f) => ({ f });

test('loose window shows its slot number', () => {
  const slots = chipSlots(W('a', null, 'b'), []);
  assert.equal(windowLabel(slots, 'a'), '1');
  assert.equal(windowLabel(slots, 'b'), '3'); // open spots keep their position
});

test('folder member shows N.m by member order', () => {
  const slots = chipSlots([...W('a', 'b'), F('F')], [{ name: 'F', ids: ['x', 'y', 'z'] }]);
  assert.equal(windowLabel(slots, 'x'), '3.1');
  assert.equal(windowLabel(slots, 'z'), '3.3');
});

test('members beyond the 9th get no number', () => {
  const slots = chipSlots([F('F')], [{ name: 'F', ids: ids('m', 11) }]);
  assert.equal(windowLabel(slots, 'm8'), '1.9');
  assert.equal(windowLabel(slots, 'm9'), '');
});

test('slot 10 or higher gets no number', () => {
  const slots = chipSlots([...W(...ids('w', 10)), F('F')], [{ name: 'F', ids: ['x'] }]);
  assert.equal(windowLabel(slots, 'w8'), '9');
  assert.equal(windowLabel(slots, 'w9'), '');
  assert.equal(windowLabel(slots, 'x'), '');
});

test('not shown (minimized) gets no number', () => {
  const slots = chipSlots([...W('a'), F('F')], [{ name: 'F', ids: ['x'] }]);
  assert.equal(windowLabel(slots, 'a', false), '');
  assert.equal(windowLabel(slots, 'x', false), '');
});

test('window in no slot gets no number', () => {
  assert.equal(windowLabel(chipSlots(W('a'), []), 'nope'), '');
  assert.equal(windowLabel([], 'a'), '');
});
