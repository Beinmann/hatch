import test from 'node:test';
import assert from 'node:assert/strict';
import { folderToggle, hidePlan, showPlan, subNumbers, folderLeaderOpen, folderLeaderKey, ctrlFolderPress, ctrlPromptKey } from '../public/folder-keys.js';
import { groupWindows, joinPatches, reorderPatches, orderFolders, renameInOrder } from '../public/folders.js';
import { chipSlots, slotNumber } from '../public/taskbar-order.js';
import { startHatch } from './helpers.js';

const M = (id, minimized = false) => ({ id, minimized });
const P = (id, o = {}) => ({ id, title: id, type: 'note', ...o });

test('folderToggle / hidePlan: any visible member hides all, all hidden shows', () => {
  assert.equal(folderToggle([M('a', true), M('b')]), 'hide');
  assert.equal(folderToggle([M('a', true), M('b', true)]), 'show');
  assert.deepEqual(hidePlan([M('a', true), M('b'), M('c')]), ['b', 'c']);
});

test('showPlan: restores the minimized, the last-focused member ends on top', () => {
  const ms = [M('a', true), M('b', true), M('c')];
  assert.deepEqual(showPlan(ms, ['x', 'b', 'a']), { restore: ['a', 'b'], top: 'b' });
  assert.deepEqual(showPlan(ms, ['c']), { restore: ['a', 'b'], top: 'c' });
  assert.deepEqual(showPlan(ms, []), { restore: ['b', 'a'], top: 'a' });
  assert.deepEqual(showPlan([], ['a']), { restore: [], top: null });
});

test('subNumbers: fixed by position, first 9 only', () => {
  const ids = Array.from({ length: 11 }, (_, i) => `w${i}`);
  const s = subNumbers(ids);
  assert.equal(s.length, 9); assert.deepEqual(s[0], { id: 'w0', n: 1 }); assert.deepEqual(s[8], { id: 'w8', n: 9 });
});

test('leader + N on a folder: one member goes straight, several open the popover', () => {
  assert.deepEqual(folderLeaderOpen(['a']), { kind: 'go', id: 'a' });
  assert.deepEqual(folderLeaderOpen(['a', 'b']), { kind: 'popover' });
  assert.deepEqual(folderLeaderOpen([]), { kind: 'none' });
});

test('numbered popover keys: digit picks, 0 shows all, Escape cancels, unknown digit and modifiers wait', () => {
  const ids = ['a', 'b', 'c'];
  const k = (code, key = code) => folderLeaderKey(ids, { code, key });
  assert.deepEqual(k('Digit2', '2'), { action: 'pick', id: 'b' });
  assert.deepEqual(k('Numpad3', '3'), { action: 'pick', id: 'c' });
  assert.deepEqual(k('Digit0', '0'), { action: 'all' });
  assert.deepEqual(k('Digit4', '4'), { action: 'ignore' });
  assert.deepEqual(k('ShiftLeft', 'Shift'), { action: 'ignore' });
  assert.deepEqual(k('Escape', 'Escape'), { action: 'cancel' });
  assert.deepEqual(k('KeyX', 'x'), { action: 'cancel' });
  const many = Array.from({ length: 12 }, (_, i) => `w${i}`);
  assert.deepEqual(folderLeaderKey(many, { code: 'Digit9', key: '9' }), { action: 'pick', id: 'w8' });
});

test('member order: folderOrder sorts members, unordered keep list order first, bad values count as absent', () => {
  const ps = [P('a', { folder: 'F', folderOrder: 2 }), P('b', { folder: 'F', folderOrder: 1 }), P('c', { folder: 'F' }), P('d', { folder: 'F', folderOrder: -1 }), P('e', { folder: 'F', folderOrder: 1.5 })];
  assert.deepEqual(groupWindows(ps, 'main').folders[0].ids, ['c', 'd', 'e', 'b', 'a']);
});

test('joinPatches: joiners go last in the order given; reorderPatches changes only what moved', () => {
  const ps = [P('a', { folder: 'F', folderOrder: 1 }), P('b', { folder: 'F', folderOrder: 2 }), P('x'), P('y')];
  assert.deepEqual(joinPatches(ps, 'main', 'F', ['x', 'y']), [{ id: 'x', folder: 'F', folderOrder: 3 }, { id: 'y', folder: 'F', folderOrder: 4 }]);
  assert.deepEqual(joinPatches(ps, 'main', 'New', ['x', 'y']), [{ id: 'x', folder: 'New', folderOrder: 1 }, { id: 'y', folder: 'New', folderOrder: 2 }]);
  assert.deepEqual(reorderPatches(ps, ['a', 'b'], 'b', 'a'), [{ id: 'b', folderOrder: 1 }, { id: 'a', folderOrder: 2 }]);
  assert.deepEqual(reorderPatches(ps, ['a', 'b'], 'a', null), [{ id: 'b', folderOrder: 1 }, { id: 'a', folderOrder: 2 }]);
  assert.deepEqual(reorderPatches(ps, ['a', 'b'], 'a', 'b'), []);
});

test('folder chip order: first load alphabetical, saved order wins, new folders last, rename keeps the place', () => {
  const fs = [{ name: 'Alpha', ids: ['a'] }, { name: 'Beta', ids: ['b'] }, { name: 'Gamma', ids: ['c'] }];
  assert.deepEqual(orderFolders(fs, []).map((f) => f.name), ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(orderFolders(fs, ['Gamma', 'Alpha']).map((f) => f.name), ['Gamma', 'Alpha', 'Beta']);
  assert.deepEqual(orderFolders(fs, ['Gone', 'Beta']).map((f) => f.name), ['Beta', 'Alpha', 'Gamma']);
  assert.deepEqual(renameInOrder(['Gamma', 'Alpha'], 'Alpha', 'Zed'), ['Gamma', 'Zed']);
});

test('slot numbering follows a reordered folder', () => {
  const fs = orderFolders([{ name: 'Alpha', ids: ['a'] }, { name: 'Beta', ids: ['b1', 'b2'] }], ['Beta', 'Alpha']);
  const slots = chipSlots(['x', null, 'y'], fs);
  assert.equal(slotNumber(slots, 'b2'), 4); assert.equal(slotNumber(slots, 'a'), 5); assert.equal(slotNumber(slots, 'y'), 3);
});

test('server keeps folderOrder only with a folder and rejects bad patches', async () => {
  const h = await startHatch();
  try {
    const p = (await h.call('POST', '/api/panels', { type: 'note', props: { markdown: 'x' } })).data;
    const ok = (await h.call('PATCH', `/api/panels/${p.id}`, { folder: 'F', folderOrder: 3 })).data;
    assert.equal(ok.folderOrder, 3);
    assert.equal((await h.call('PATCH', `/api/panels/${p.id}`, { folderOrder: -2 })).status, 400);
    const out = (await h.call('PATCH', `/api/panels/${p.id}`, { folder: null })).data;
    assert.equal(out.folderOrder, undefined);
  } finally { await h.close(); }
});

test('Ctrl+N press on a folder: all hidden shows all, any visible asks', () => {
  assert.equal(ctrlFolderPress([M('a', true), M('b', true)]), 'show');
  assert.equal(ctrlFolderPress([M('a', true), M('b')]), 'prompt');
  assert.equal(ctrlFolderPress([M('a'), M('b')]), 'prompt');
});

test('Ctrl+N prompt keys: digit with or without Ctrl, 0 hides, Esc and Ctrl+N cancel', () => {
  const ids = ['a', 'b', 'c'];
  const k = (code, extra = {}) => ctrlPromptKey(ids, 5, { key: code.replace('Digit', ''), code, ...extra });
  assert.deepEqual(k('Digit2'), { action: 'pick', id: 'b' });
  assert.deepEqual(k('Digit2', { ctrlKey: true }), { action: 'pick', id: 'b' });
  assert.deepEqual(k('Digit0'), { action: 'hide' });
  assert.deepEqual(k('Digit0', { ctrlKey: true }), { action: 'hide' });
  assert.deepEqual(k('Digit5', { ctrlKey: true }), { action: 'cancel' }); // Ctrl+N again
  assert.deepEqual(k('Digit5'), { action: 'ignore' }); // plain 5: no member 5, stay open
  assert.deepEqual(k('Digit7'), { action: 'ignore' });
  assert.deepEqual(ctrlPromptKey(ids, 5, { key: 'Escape', code: 'Escape' }), { action: 'cancel' });
  assert.deepEqual(ctrlPromptKey(ids, 5, { key: 'Control', code: 'ControlLeft' }), { action: 'ignore' });
  assert.deepEqual(ctrlPromptKey(ids, 5, { key: 'a', code: 'KeyA' }), { action: 'pass' });
});
