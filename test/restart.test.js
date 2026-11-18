import test from 'node:test';
import assert from 'node:assert/strict';
import { restarted } from '../public/restart.js';
import { startHatch } from './helpers.js';

test('restarted: only a known, different start id counts', () => {
  assert.equal(restarted(null, 'a'), false, 'first snapshot');
  assert.equal(restarted('a', 'a'), false, 'same server after a network blip');
  assert.equal(restarted('a', undefined), false, 'older server without an id');
  assert.equal(restarted('a', 'b'), true);
});

test('info and the snapshot carry a stable per-start id that is not the token', async () => {
  const h = await startHatch();
  try {
    const a = (await h.call('GET', '/api/info')).data.bootId; const b = (await h.call('GET', '/api/info')).data.bootId;
    assert.match(a, /^[0-9a-f]{16}$/); assert.equal(a, b);
    assert.ok(!a.includes(h.hatch.token));
  } finally { await h.close(); }
});
