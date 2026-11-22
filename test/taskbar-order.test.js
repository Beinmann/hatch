import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeOrder, moveItem, dropZone, placeLoose, chipSlots, slotNumber, entryKey, parseRow, reconcileRow, migrateRow, combineRow, joinRow, releaseRow, renameRow, moveEntry, placeEntry } from '../public/taskbar-order.js';

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

test('placeLoose: first layout packs in order; closing leaves a spot, a new window fills it', () => {
  let l = placeLoose([], ['a', 'b', 'c'], ['a', 'b', 'c']);
  assert.deepEqual(l, ['a', 'b', 'c']);
  l = placeLoose(l, ['a', 'c'], ['a', 'c']);
  assert.deepEqual(l, ['a', null, 'c']);
  l = placeLoose(l, ['a', 'c', 'd', 'e'], ['a', 'c', 'd', 'e']);
  assert.deepEqual(l, ['a', 'd', 'c', 'e'], 'lowest free spot first, then the end');
});

test('placeLoose: trailing open spots vanish; foldered windows free their spot', () => {
  assert.deepEqual(placeLoose(['a', 'b', 'c'], ['a', 'b'], ['a', 'b']), ['a', 'b']);
  assert.deepEqual(placeLoose(['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'c']), ['a', null, 'c']);
  assert.deepEqual(placeLoose(undefined, ['a'], ['a']), ['a']);
});

// Rows are written compactly in the tests: 'a' = window a, 'F:' = folder F, '-' = open spot.
const R = (...xs) => xs.map((x) => (x === '-' ? null : x.endsWith(':') ? { f: x.slice(0, -1) } : { w: x }));
const S = (row) => row.map((e) => (e === null ? '-' : e.f !== undefined ? `${e.f}:` : e.w));
const W = (...ids) => ids.map((w) => ({ w }));
const F = (...names) => names.map((f) => ({ f }));

test('chipSlots: one row, open spots included; a folder is one slot; numbers follow the position', () => {
  const slots = chipSlots(R('c', '-', 'F:', 'b'), [{ name: 'F', ids: ['x', 'y'] }]);
  assert.deepEqual(slots.map((s) => s.kind === 'win' ? s.id : s.kind === 'empty' ? '-' : `folder:${s.name}`), ['c', '-', 'folder:F', 'b']);
  assert.equal(slotNumber(slots, 'b'), 4);
  assert.equal(slotNumber(slots, 'y'), 3, 'a folder member shows its folder chip number');
  assert.equal(slotNumber(slots, 'nope'), 0);
  assert.equal(chipSlots(R('G:'), [])[0].kind, 'empty', 'a folder that does not exist is an open spot');
});

test('window id and folder name never collide', () => {
  const row = reconcileRow([], [...W('x'), ...F('x')]);
  assert.deepEqual(S(row), ['x', 'x:']);
  assert.notEqual(entryKey({ w: 'x' }), entryKey({ f: 'x' }));
  assert.deepEqual(S(reconcileRow(row, W('x'))), ['x'], 'the folder x leaves, the window x stays');
  assert.deepEqual(S(reconcileRow(row, F('x'))), ['-', 'x:'], 'the window x leaves, the folder x stays');
});

test('reconcileRow: a new window fills the first open spot, else the end (scenario: folder at 2, new window goes to 3)', () => {
  assert.deepEqual(S(reconcileRow(R('a', 'F:'), [...W('a', 'b'), ...F('F')])), ['a', 'F:', 'b']);
  assert.deepEqual(S(reconcileRow(R('a', '-', 'F:'), [...W('a', 'b'), ...F('F')])), ['a', 'b', 'F:']);
});

test('reconcileRow: closed windows and vanished folders leave open spots, trailing ones vanish', () => {
  assert.deepEqual(S(reconcileRow(R('a', 'b', 'F:', 'c'), [...W('a', 'c'), ...F('F')])), ['a', '-', 'F:', 'c']);
  assert.deepEqual(S(reconcileRow(R('a', 'F:', 'b'), W('a', 'b'))), ['a', '-', 'b']);
  assert.deepEqual(S(reconcileRow(R('a', 'b', 'F:'), W('a'))), ['a']);
  assert.deepEqual(S(reconcileRow(undefined, W('a'))), ['a']);
});

test('combineRow: the new folder takes the lowest slot, the other window leaves an open spot', () => {
  assert.deepEqual(S(combineRow(R('a', 'b', 'c'), 'F', ['a', 'b'])), ['F:', '-', 'c']);
  assert.deepEqual(S(combineRow(R('a', 'b', 'c'), 'F', ['c', 'b'])), ['a', 'F:']);
  assert.deepEqual(S(combineRow(R('a', 'b', 'c'), 'F', ['b'])), ['a', 'F:', 'c'], 'one window (palette): the folder takes its slot');
  assert.deepEqual(S(combineRow(R('a', '-', 'c'), 'F', ['zz'])), ['a', 'F:', 'c'], 'no known slot: first open spot');
});

test('joinRow: the window leaves an open spot, the folder keeps its slot', () => {
  assert.deepEqual(S(joinRow(R('a', 'F:', 'c'), ['a'])), ['-', 'F:', 'c']);
  assert.deepEqual(S(joinRow(R('F:', 'c'), ['c'])), ['F:']);
});

test('releaseRow: a window taken out takes the first open spot; the last member leaving frees the folder slot first', () => {
  assert.deepEqual(S(releaseRow(R('a', 'F:', 'c'), ['x'])), ['a', 'F:', 'c', 'x'], 'no spot open: the end');
  assert.deepEqual(S(releaseRow(R('a', '-', 'F:'), ['x'])), ['a', 'x', 'F:']);
  assert.deepEqual(S(releaseRow(R('a', 'F:', 'c'), ['x'], 'F')), ['a', 'x', 'c'], 'F dissolves: x reuses its slot');
});

test('releaseRow (ungroup all): members take the first open spots in member order, the folder spot first', () => {
  assert.deepEqual(S(releaseRow(R('a', 'F:', 'c', '-', 'e'), ['x', 'y', 'z'], 'F')), ['a', 'x', 'c', 'y', 'e', 'z']);
  assert.deepEqual(S(releaseRow(R('F:'), ['x', 'y'], 'F')), ['x', 'y']);
});

test('renameRow keeps the slot', () => {
  assert.deepEqual(S(renameRow(R('a', 'F:', 'c'), 'F', 'G')), ['a', 'G:', 'c']);
  assert.deepEqual(S(renameRow(R('F:'), 'x', 'G')), ['F:']);
});

test('moveEntry: drag a folder chip among loose chips; open spots are packed; no-ops', () => {
  assert.deepEqual(S(moveEntry(R('a', '-', 'b', 'F:'), { f: 'F' }, { w: 'a' })), ['F:', 'a', 'b']);
  assert.deepEqual(S(moveEntry(R('a', 'F:', 'b'), { w: 'a' }, null)), ['F:', 'b', 'a']);
  assert.deepEqual(S(moveEntry(R('a', 'F:', 'b'), { w: 'F' }, null)), ['a', 'F:', 'b'], 'a window named like the folder is not the folder');
  assert.deepEqual(S(moveEntry(R('a', 'F:'), { f: 'F' }, { f: 'F' })), ['a', 'F:']);
});

test('placeEntry: drop into an open spot leaves the old slot open; an occupied slot changes nothing', () => {
  assert.deepEqual(S(placeEntry(R('a', '-', 'F:'), { w: 'a' }, 1)), ['-', 'a', 'F:']);
  assert.deepEqual(S(placeEntry(R('a', '-', 'F:'), { f: 'F' }, 1)), ['a', 'F:']);
  assert.deepEqual(S(placeEntry(R('a', 'b'), { w: 'a' }, 1)), ['a', 'b']);
});

test('parseRow: clean rows, the old format and junk', () => {
  assert.deepEqual(S(parseRow([{ w: 'a' }, null, { f: 'F' }, { w: 'a' }, 5, { x: 1 }, null])), ['a', '-', 'F:']);
  assert.equal(parseRow(['a', 'b']), null, 'old layout: migrate');
  assert.equal(parseRow(null), null);
  assert.equal(parseRow('nope'), null);
  assert.deepEqual(parseRow([]), []);
});

test('migrateRow: old loose layout, then the folders in their old order, as numbered before', () => {
  // old taskbar: loose a, open spot, b; folders Zed then Alpha (saved order); window c is in folder Zed
  assert.deepEqual(S(migrateRow(['a', null, 'b'], ['a', 'b', 'c'], ['a', 'b'], ['Zed', 'Alpha'])), ['a', '-', 'b', 'Zed:', 'Alpha:']);
  // only the old loose order was saved (packed): ids in that order, unseen ones appended, closed ones leave a spot a new window fills (as before)
  assert.deepEqual(S(migrateRow(['gone', 'b', 'a'], ['a', 'b', 'd'], ['a', 'b', 'd'], ['F'])), ['d', 'b', 'a', 'F:']);
  // nothing saved: windows in default order, folders after
  assert.deepEqual(S(migrateRow(undefined, ['a', 'b'], ['a'], ['F'])), ['a', 'F:']);
});

test('row logic holds together for the two reported scenarios', () => {
  // (a) windows 1 and 2 of three combined: the folder takes slot 1, slot 2 is open, the third stays at 3
  let row = reconcileRow([], W('a', 'b', 'c'));
  row = combineRow(row, 'F', ['a', 'b']);
  assert.deepEqual(S(reconcileRow(row, [...W('c'), ...F('F')])), ['F:', '-', 'c']);
  // (b) one loose window and one folder at slots 1 and 2: a new window goes to slot 3
  assert.deepEqual(S(reconcileRow(R('a', 'F:'), [...W('a', 'n'), ...F('F')])), ['a', 'F:', 'n']);
});

test('slotNumber: only 1-9 are reachable', () => {
  const ids = Array.from({ length: 11 }, (_, i) => `w${i}`);
  const slots = chipSlots(W(...ids), []);
  assert.equal(slotNumber(slots, 'w8'), 9);
  assert.equal(slotNumber(slots, 'w9'), 0);
});

test('chipBadges: dim numbers for filled slots 1-9, none for open spots or beyond 9', async () => {
  const { chipBadges, chipSlots } = await import('../public/taskbar-order.js');
  const row = [{ w: 'a' }, null, { f: 'F' }, ...Array.from({ length: 8 }, (_, i) => ({ w: `x${i}` }))];
  const b = chipBadges(chipSlots(row, [{ name: 'F', ids: ['m'] }]));
  assert.deepEqual(b.map((x) => x.n), [1, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(b.map((x) => x.slot), [0, 2, 3, 4, 5, 6, 7, 8]);
});
