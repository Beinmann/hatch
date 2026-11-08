import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sniff, saveUpload } from '../src/uploads.js';
import { tmp, PNG } from './helpers.js';

test('sniff detects images by magic bytes', () => {
  assert.equal(sniff(PNG), 'png');
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
  assert.equal(sniff(Buffer.from('GIF89a')), 'gif');
  assert.equal(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(sniff(Buffer.from('<svg onload=alert(1)>')), null);
  assert.equal(sniff(Buffer.alloc(0)), null);
});

test('uploads are numbered max+1 and return absolute paths', () => {
  const dir = tmp();
  assert.equal(saveUpload(dir, PNG).name, '1.png');
  assert.equal(saveUpload(dir, PNG).name, '2.png');
  fs.writeFileSync(path.join(dir, '17.png'), PNG);
  const r = saveUpload(dir, PNG);
  assert.equal(r.name, '18.png'); assert.ok(path.isAbsolute(r.path));
  assert.throws(() => saveUpload(dir, Buffer.from('hello')), /not a PNG/);
});
