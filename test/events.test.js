import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createBus } from '../src/events.js';
import { readSse, waitFor } from './helpers.js';

class Response extends EventEmitter {
  constructor() { super(); this.frames = []; this.block = false; this.destroyed = false; this.writableEnded = false; }
  writeHead(status) { this.status = status; }
  write(frame) { if (this.fail) throw new Error('broken write'); this.frames.push(frame); return !this.block; }
  end(body) { if (body) this.frames.push(body); this.writableEnded = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
}
const events = (response) => response.frames.filter(frame => frame.startsWith('event:')).map(frame => /^event: ([^\n]+)/.exec(frame)[1]);

test('backpressured clients resume queued events in order without slowing healthy clients', () => {
  const bus = createBus(() => ({ hello: 'snapshot' })); const slow = new Response(); const fast = new Response(); const req = new EventEmitter(); let cleaned = 0;
  try {
    bus.subscribe(req, slow, () => cleaned++); bus.subscribe(new EventEmitter(), fast);
    slow.block = true; bus.emit('one', { value: 1 }); bus.emit('two', { value: 2 }); bus.emit('three', { value: 3 });
    assert.deepEqual(events(slow), ['snapshot', 'one']); assert.deepEqual(events(fast), ['snapshot', 'one', 'two', 'three']);
    slow.block = false; slow.emit('drain'); assert.deepEqual(events(slow), ['snapshot', 'one', 'two', 'three']);
    req.emit('close'); slow.emit('close'); slow.emit('error', new Error('late socket error')); assert.equal(cleaned, 1); assert.equal(bus.size(), 1);
    assert.equal(slow.listenerCount('drain'), 0);
  } finally { bus.close(); }
});

test('queue overflow disconnects only the slow stream and releases its subscription once', () => {
  const bus = createBus(() => ({}), { maxQueuedBytes: 64 }); const slow = new Response(); const fast = new Response(); let cleaned = 0;
  try {
    bus.subscribe(new EventEmitter(), slow, () => cleaned++); bus.subscribe(new EventEmitter(), fast);
    slow.block = true; bus.emit('start', 'blocked'); bus.emit('queued', 'x'.repeat(32)); bus.emit('overflow', 'x'.repeat(32));
    assert.equal(slow.destroyed, true); assert.equal(cleaned, 1); assert.equal(bus.size(), 1);
    assert.deepEqual(events(fast), ['snapshot', 'start', 'queued', 'overflow']);
    slow.emit('drain'); slow.emit('close'); assert.equal(cleaned, 1);
  } finally { bus.close(); }
});

test('a stalled stream times out and healthy streams continue receiving events', async () => {
  const bus = createBus(() => ({}), { stallMs: 20 }); const slow = new Response(); const fast = new Response(); let cleaned = 0;
  try {
    bus.subscribe(new EventEmitter(), slow, () => cleaned++); bus.subscribe(new EventEmitter(), fast);
    slow.block = true; bus.emit('blocked', {}); await waitFor(() => slow.destroyed);
    assert.equal(cleaned, 1); bus.emit('after', {}); assert.equal(events(fast).at(-1), 'after');
  } finally { bus.close(); }
});

test('write failures, response closure and bus shutdown clean up exactly once', () => {
  const bus = createBus(() => ({})); const broken = new Response(); const ending = new Response(); const blocked = new Response(); const counts = [0, 0, 0];
  bus.subscribe(new EventEmitter(), broken, () => counts[0]++); bus.subscribe(new EventEmitter(), ending, () => counts[1]++); bus.subscribe(new EventEmitter(), blocked, () => counts[2]++);
  broken.fail = true; bus.emit('failure', {}); assert.equal(broken.destroyed, true);
  ending.end(); blocked.block = true; bus.emit('blocked', {}); bus.close(); bus.close();
  assert.deepEqual(counts, [1, 1, 1]); assert.equal(blocked.destroyed, true); assert.equal(bus.size(), 0);
  const late = new Response(); let lateCleanup = 0; bus.subscribe(new EventEmitter(), late, () => lateCleanup++);
  assert.equal(late.status, 503); assert.equal(lateCleanup, 1); assert.equal(bus.size(), 0);
  assert.doesNotThrow(() => bus.emit('ignored', { circular: (() => { const value = {}; value.self = value; return value; })() }));
});

test('a failed snapshot releases caller bookkeeping before propagating the error', () => {
  const bus = createBus(() => { throw new Error('snapshot failed'); }); let cleaned = 0; const res = new Response();
  try { assert.throws(() => bus.subscribe(new EventEmitter(), res, () => cleaned++), /snapshot failed/); assert.equal(cleaned, 1); assert.equal(bus.size(), 0); assert.equal(res.status, undefined); }
  finally { bus.close(); }
});

test('real HTTP event clients disconnect cleanly and can subscribe to a fresh snapshot', async () => {
  let cleaned = 0; const bus = createBus(() => ({ count: cleaned }));
  const server = http.createServer((req, res) => bus.subscribe(req, res, () => cleaned++)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (let i = 0; i < 2; i++) {
      const events = await readSse(base, {}, list => list.some(event => event.event === 'snapshot'));
      assert.equal(JSON.parse(events[0].data).count, i); await waitFor(() => bus.size() === 0 && cleaned === i + 1);
    }
    bus.close(); assert.equal((await fetch(base)).status, 503); assert.equal(cleaned, 3);
  } finally { bus.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('a large initial snapshot can drain before the bounded follow-up queue resumes', () => {
  const bus = createBus(() => ({ text: 'x'.repeat(10000) }), { maxQueuedBytes: 64 }); const res = new Response(); const write = res.write.bind(res);
  res.write = frame => { write(frame); return !frame.startsWith('event: snapshot'); };
  try {
    bus.subscribe(new EventEmitter(), res); assert.equal(res.destroyed, false); assert.equal(bus.size(), 1);
    bus.emit('after', {}); assert.deepEqual(events(res), ['snapshot']);
    res.write = write; res.emit('drain'); assert.deepEqual(events(res), ['snapshot', 'after']); assert.equal(bus.size(), 1);
  } finally { bus.close(); }
});
