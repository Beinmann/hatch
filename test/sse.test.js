import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSseWriter } from '../src/sse.js';
import { waitFor } from './helpers.js';

class Response extends EventEmitter {
  constructor() { super(); this.frames = []; this.block = false; this.destroyed = false; this.writableEnded = false; }
  write(frame) { this.frames.push(frame); return !this.block; }
  end() { this.writableEnded = true; this.emit('finish'); this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
}

test('ending a backpressured writer drains output and its final exit frame in order', () => {
  const req = new EventEmitter(); const res = new Response(); let cleaned = 0;
  const writer = createSseWriter(req, res, { onClose: () => cleaned++ });
  res.block = true; writer.write('first'); writer.write('second'); writer.end('exit'); writer.write('late');
  assert.deepEqual(res.frames, ['first']); assert.equal(res.writableEnded, false); assert.equal(cleaned, 0);
  res.block = false; res.emit('drain'); assert.deepEqual(res.frames, ['first', 'second', 'exit']);
  assert.equal(res.writableEnded, true); assert.equal(cleaned, 1); req.emit('close'); writer.destroy(); assert.equal(cleaned, 1);
});

test('an ending writer still disconnects if its final data never drains', async () => {
  const res = new Response(); let cleaned = 0; const writer = createSseWriter(new EventEmitter(), res, { stallMs: 20, onClose: () => cleaned++ });
  res.block = true; writer.write('output'); writer.end('exit'); await waitFor(() => res.destroyed);
  assert.equal(cleaned, 1); assert.equal(res.writableEnded, false);
});

test('a dead response releases writer bookkeeping before accepting any output', () => {
  const res = new Response(); res.destroyed = true; let cleaned = 0;
  const writer = createSseWriter(new EventEmitter(), res, { onClose: () => cleaned++ });
  writer.write('never sent'); writer.end('never sent either'); assert.deepEqual(res.frames, []); assert.equal(cleaned, 1);
});
