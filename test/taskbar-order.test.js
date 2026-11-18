import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeOrder, moveItem, dropZone, chipSlots, slotNumber } from '../public/taskbar-order.js';

test('mergeOrder: nothing saved keeps the default order', () => {
  assert.deepEqual(mergeOrder(undefined, ['a', 'b', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(mergeOrder([], ['a', 'b']), ['a', 'b']);
});

test('mergeOrder: saved order wins, closed windows drop out, new ones are appended', () => {
  assert.deepEqual(mergeOrder(['c', 'x', 'a'], ['a', 'b', 'c', 'd']), ['c', 'a', 'b', 'd']);
});

test('mergeOrder: duplicates and junk in the saved value are ignored', () => {
  assert.deepEqual(mergeOrder(['a', 'a', 7, null], ['a', 'b']), ['a', 'b']);
  assert.deepEqual(mergeOrder('nope', ['a']), ['a']);
});

test('moveItem: before another, to the end, no-ops', () => {
  const o = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveItem(o, 'd', 'b'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(moveItem(o, 'a', null), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveItem(o, 'b', 'b'), o);
  assert.deepEqual(moveItem(o, 'zz', 'a'), o);
  assert.deepEqual(moveItem(o, 'a', 'zz'), o);
  assert.notEqual(moveItem(o, 'b', 'b'), o); // a copy, never the input
});

test('dropZone: edges reorder, the middle joins', () => {
  const r = { left: 100, width: 100 };
  assert.equal(dropZone(r, 110), 'before');
  assert.equal(dropZone(r, 150), 'mid');
  assert.equal(dropZone(r, 190), 'after');
  assert.equal(dropZone({ left: 0, width: 0 }, 0), 'mid');
});

test('chipSlots: loose chips in order (minimized included), then folders; numbers follow the position', () => {
  const slots = chipSlots(['c', 'a', 'x', 'b'], ['a', 'b', 'c'], [{ name: 'F', ids: ['x'] }]);
  assert.deepEqual(slots.map((s) => s.kind === 'win' ? s.id : `folder:${s.name}`), ['c', 'a', 'b', 'folder:F']);
  assert.equal(slotNumber(slots, 'a'), 2);
  assert.equal(slotNumber(slots, 'x'), 4, 'a folder member shows its folder chip number');
  assert.equal(slotNumber(slots, 'nope'), 0);
});

test('slotNumber: only 1-9 are reachable', () => {
  const ids = Array.from({ length: 11 }, (_, i) => `w${i}`);
  const slots = chipSlots(ids, ids, []);
  assert.equal(slotNumber(slots, 'w8'), 9);
  assert.equal(slotNumber(slots, 'w9'), 0);
});
