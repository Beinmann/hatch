import test from 'node:test';
import assert from 'node:assert/strict';
import { dockIds, moveBefore, gapAt, orderPatches } from '../public/dock-order.js';

const P = (id, o, created = '2026-01-01T00:00:0' + id.length, placement = 'dock') => ({ id, placement, dockOrder: o, created });

test('dockIds: numbered first, unnumbered after by creation, floats ignored', () => {
  const ps = [P('c', undefined, '2026-01-01T00:00:03Z'), P('b', 1), P('a', 0), P('d', undefined, '2026-01-01T00:00:02Z'), P('f', 0, 'x', 'float')];
  assert.deepEqual(dockIds(ps), ['a', 'b', 'd', 'c']);
});

test('moveBefore: up, down, to the end, no-ops', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveBefore(ids, 'c', 'a'), ['c', 'a', 'b', 'd']);
  assert.deepEqual(moveBefore(ids, 'a', 'd'), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveBefore(ids, 'a', null), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveBefore(ids, 'b', 'b'), ids);
  assert.deepEqual(moveBefore(ids, 'b', 'c'), ids);
  assert.deepEqual(moveBefore(ids, 'zz', 'a'), ids);
  assert.deepEqual(moveBefore(ids, 'a', 'zz'), ids);
  assert.notEqual(moveBefore(ids, 'b', 'c'), ids); // always a copy
});

test('gapAt: gap index from pointer position', () => {
  const mids = [50, 150, 250];
  assert.equal(gapAt(mids, 0), 0);
  assert.equal(gapAt(mids, 100), 1);
  assert.equal(gapAt(mids, 200), 2);
  assert.equal(gapAt(mids, 999), 3);
  assert.equal(gapAt([], 5), 0);
});

test('orderPatches: only changed ranks', () => {
  const ps = [P('a', 0), P('b', 1), P('c', undefined)];
  assert.deepEqual(orderPatches(['a', 'b', 'c'], ps), [{ id: 'c', dockOrder: 2 }]);
  assert.deepEqual(orderPatches(['c', 'a', 'b'], ps), [{ id: 'c', dockOrder: 0 }, { id: 'a', dockOrder: 1 }, { id: 'b', dockOrder: 2 }]);
});
