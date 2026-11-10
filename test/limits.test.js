import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRateLimitEvent, createLimits } from '../src/limits.js';
import { startHatch } from './helpers.js';

const ev = { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1900000000 }, seven_day: { utilization: 0.1 } } } };

test('parseRateLimitEvent reads both windows and ignores other events', () => {
  const r = parseRateLimitEvent(ev);
  assert.equal(Math.round(r.fiveHour.percent), 42);
  assert.equal(r.fiveHour.resetsAt, new Date(1900000000 * 1000).toISOString());
  assert.equal(Math.round(r.sevenDay.percent), 10);
  assert.equal(parseRateLimitEvent({ type: 'assistant' }), null);
});

test('createLimits caches within the TTL, forces after the throttle, keeps old data on failure', async () => {
  let t = 0; let calls = 0; let fail = false;
  const l = createLimits({ now: () => t, probe: async () => { calls++; if (fail) throw new Error('boom'); return parseRateLimitEvent(ev); } });
  await l.get(); await l.get();
  assert.equal(calls, 1);
  t = 5000; await l.get(true); assert.equal(calls, 1, 'forced refresh is throttled');
  t = 40000; fail = true;
  const r = await l.get(true);
  assert.equal(calls, 2);
  assert.equal(r.claude.stale, 'boom');
  assert.ok(r.claude.fiveHour);
});

test('first failure is reported as error, and /api/limits serves it', async () => {
  const h = await startHatch({ limitsProbe: async () => { throw new Error('no cli'); } });
  try {
    const r = await h.call('GET', '/api/limits');
    assert.match(r.data.claude.error, /no cli/);
  } finally { await h.close?.(); }
});
