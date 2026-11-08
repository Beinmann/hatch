import test from 'node:test';
import assert from 'node:assert/strict';

test('pickRestore takes the most recently minimized floating popup of the workspace', async () => {
  const { pickRestore } = await import('../public/restore.js');
  const f = (id, o = {}) => ({ id, placement: 'float', minimized: true, ...o });
  const panels = [f('a'), f('b'), f('c', { ws: 'other' }), f('d', { placement: 'dock' }), f('e', { minimized: false }), f('s', { ws: 'other', sticky: true })];
  const order = new Map([['a', 1], ['b', 2], ['c', 9], ['s', 3]]);
  assert.equal(pickRestore(panels, order, 'main').id, 's');
  assert.equal(pickRestore(panels.filter((p) => p.id !== 's'), order, 'main').id, 'b');
  assert.equal(pickRestore(panels, order, 'other').id, 'c');
  assert.equal(pickRestore([f('x'), f('y')], new Map(), 'main').id, 'x', 'unknown order falls back to list order');
  assert.equal(pickRestore([f('e', { minimized: false })], order, 'main'), null);
});

test('focus history falls back to the most recent open window, then the terminal', async () => {
  const { touch, pickAfterClose } = await import('../public/focus-history.js');
  let h = [];
  for (const id of ['files', 'editor', 'notes', 'editor']) h = touch(h, id);
  assert.deepEqual(h, ['editor', 'notes', 'files']);
  const open = new Set(['files', 'editor', 'notes']);
  assert.equal(pickAfterClose(h, 'editor', (id) => open.has(id)), 'notes');
  open.delete('notes');
  assert.equal(pickAfterClose(h, 'editor', (id) => open.has(id)), 'files');
  open.delete('files');
  assert.equal(pickAfterClose(h, 'editor', (id) => open.has(id)), null);
});
