import test from 'node:test';
import assert from 'node:assert/strict';
import { createClipboardBridge } from '../public/clipboard-bridge.js';

const setup = (opts = {}) => {
  const s = { t: 0, allowed: true, written: [], fb: true };
  s.bridge = createClipboardBridge({
    write: async (x) => { if (!s.allowed) throw new Error('denied'); s.written.push(x); },
    fallback: async () => s.fb, now: () => s.t, ...opts,
  });
  return s;
};

test('copies directly when the browser allows it', async () => {
  const s = setup();
  assert.equal(await s.bridge.receive('a'), 'copied');
  assert.deepEqual(s.written, ['a']);
  assert.equal(s.bridge.hasPending(), false);
});

test('the same text within a second is a duplicate, later it is copied again', async () => {
  const s = setup();
  await s.bridge.receive('a');
  s.t = 500; assert.equal(await s.bridge.receive('a'), 'duplicate');
  s.t = 1500; assert.equal(await s.bridge.receive('a'), 'copied');
  assert.equal(await s.bridge.receive('b'), 'copied');
});

test('a refused write waits for the next gesture, then copies once', async () => {
  const s = setup(); s.allowed = false;
  assert.equal(await s.bridge.receive('a'), 'pending');
  s.allowed = true;
  assert.equal(await s.bridge.flush(), true);
  assert.deepEqual(s.written, ['a']);
  assert.equal(await s.bridge.flush(), null);
});

test('a newer text replaces the waiting one; a pending copy expires', async () => {
  const s = setup(); s.allowed = false;
  await s.bridge.receive('a'); await s.bridge.receive('b');
  s.allowed = true;
  await s.bridge.flush();
  assert.deepEqual(s.written, ['b']);
  s.allowed = false; await s.bridge.receive('c');
  s.t = 31000; s.allowed = true;
  assert.equal(s.bridge.hasPending(), false);
  assert.equal(await s.bridge.flush(), null);
});

test('a failed flush keeps the text waiting', async () => {
  const s = setup(); s.allowed = false; s.fb = false;
  await s.bridge.receive('a');
  assert.equal(await s.bridge.flush(), false);
  assert.equal(s.bridge.hasPending(), true);
});
