import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlots } from '../public/stream-slots.js';

// Regression: restoring ~20 closed terminal/output windows opened 20 EventSources, used up the browser's ~6 connections
// per origin and left input and close requests queued forever. Streams now take one of a few slots.
test('only `max` streams are open at once and waiting ones start as slots free up', () => {
  const slots = createSlots(3);
  const started = [];
  const leases = Array.from({ length: 20 }, (_, i) => slots.acquire(() => started.push(i)));
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(slots.used, 3);
  assert.equal(leases[3].waiting, true);
  leases[1].release();
  assert.deepEqual(started, [0, 1, 2, 3]);
  leases[1].release(); // double release does not free another slot
  assert.equal(slots.used, 3);
  leases[5].release(); // leaving the queue before being granted
  for (const i of [0, 2, 3]) leases[i].release();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 6, 7]);
  for (let i = 0; i < 20; i++) leases[i].release();
  assert.equal(slots.used, 0);
  assert.deepEqual(started.includes(5), false);
});
