import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTouchFirst, uploadPicked } from '../public/phone-upload.js';

const mm = (table) => (q) => ({ matches: !!table[q] });

test('upload button shows on touch-first devices only', () => {
  assert.equal(isTouchFirst(mm({ '(pointer: coarse)': true, '(hover: none)': true })), true);
  assert.equal(isTouchFirst(mm({})), false); // desktop
  assert.equal(isTouchFirst(mm({ '(pointer: coarse)': true })), false); // touch laptop with a mouse
  assert.equal(isTouchFirst(undefined), false);
  assert.equal(isTouchFirst(() => { throw new Error('x'); }), false);
});

test('picked files go through the paste/drop upload functions, one call each', () => {
  const calls = [];
  const deps = { uploadImage: (f, n) => calls.push(['img', f.name, n]), uploadFile: (f) => calls.push(['file', f.name]) };
  const n = uploadPicked([{ name: 'a.png', type: 'image/png' }, { name: 'b.pdf', type: 'application/pdf' }, { name: 'c', type: '' }], deps);
  assert.equal(n, 3);
  assert.deepEqual(calls, [['img', 'a.png', 'a.png'], ['file', 'b.pdf'], ['file', 'c']]);
  assert.equal(uploadPicked(null, deps), 0);
});
