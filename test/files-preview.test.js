import test from 'node:test';
import assert from 'node:assert/strict';
import { isImageName, previewTarget, previewUrl, PREVIEW_DELAY } from '../public/panels/files-preview.js';

test('isImageName matches the supported image types only', () => {
  for (const n of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.svg']) assert.ok(isImageName(n), n);
  for (const n of ['a.txt', 'png', 'a.png.bak', '', undefined]) assert.ok(!isImageName(n), String(n));
});

test('previewTarget returns a path only for image files', () => {
  const entries = [{ name: 'pics', type: 'dir' }, { name: 'a.png', type: 'file' }, { name: 'n.txt', type: 'file' }, { name: 'x.png', type: 'broken' }];
  assert.equal(previewTarget('/home/u', entries, 'a.png'), '/home/u/a.png');
  assert.equal(previewTarget('/', entries, 'a.png'), '/a.png');
  for (const n of ['pics', 'n.txt', 'x.png', '..', '', 'missing']) assert.equal(previewTarget('/d', entries, n), null, n);
});

test('previewUrl uses the image panel file route and is encoded', () => {
  assert.equal(previewUrl('/a b/c#.png'), '/api/file?path=%2Fa%20b%2Fc%23.png');
  assert.ok(PREVIEW_DELAY > 0 && PREVIEW_DELAY <= 300);
});
