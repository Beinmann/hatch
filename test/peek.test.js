import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeek, PEEK_DELAY_MS, peekKeyOrNull } from '../public/peek.js';

// A fake clock so the delay is exact.
function setup(key = 'Alt') {
  let now = 0; let timers = []; const log = [];
  const setTimer = (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; };
  const clearTimer = (t) => { timers = timers.filter((x) => x !== t); };
  const advance = (ms) => { now += ms; for (const t of timers.filter((x) => x.at <= now)) { timers = timers.filter((x) => x !== t); t.fn(); } };
  const peek = createPeek({ onChange: (v) => log.push(v), getKey: () => key, setTimer, clearTimer });
  return { peek, log, advance };
}
const K = (key, o = {}) => ({ key, repeat: false, ...o });

test('Alt alone hides only after the delay and restores on release', () => {
  const { peek, log, advance } = setup();
  peek.keydown(K('Alt'));
  advance(PEEK_DELAY_MS - 1);
  assert.equal(peek.active, false);
  advance(1);
  assert.equal(peek.active, true);
  assert.equal(peek.keyup(K('Alt')), true, 'the release that ends a peek asks for preventDefault');
  assert.deepEqual(log, [true, false]);
});

test('a quick tap never peeks and does not ask for preventDefault', () => {
  const { peek, log, advance } = setup();
  peek.keydown(K('Alt'));
  advance(50);
  assert.equal(peek.keyup(K('Alt')), false);
  advance(1000);
  assert.deepEqual(log, []);
});

test('Alt used as a modifier (Alt+b) never peeks, even if the other key comes late', () => {
  const { peek, log, advance } = setup();
  peek.keydown(K('Alt')); peek.keydown(K('b'));
  advance(1000);
  assert.deepEqual(log, []);
  peek.keyup(K('b')); peek.keyup(K('Alt'));
  assert.deepEqual(log, []);
});

test('another key while peeking ends the peek at once', () => {
  const { peek, log, advance } = setup();
  peek.keydown(K('Alt')); advance(PEEK_DELAY_MS);
  peek.keydown(K('Tab'));
  assert.equal(peek.active, false);
  assert.equal(peek.keyup(K('Alt')), false);
  assert.deepEqual(log, [true, false]);
});

test('key auto-repeat neither restarts the timer nor ends the peek', () => {
  const { peek, log, advance } = setup();
  peek.keydown(K('Alt')); advance(100);
  peek.keydown(K('Alt', { repeat: true })); advance(PEEK_DELAY_MS - 100);
  assert.equal(peek.active, true);
  peek.keydown(K('Alt', { repeat: true }));
  assert.equal(peek.active, true);
  assert.deepEqual(log, [true]);
});

test('reset (blur, visibilitychange) restores and cancels a pending peek', () => {
  const a = setup(); a.peek.keydown(K('Alt')); a.advance(PEEK_DELAY_MS); a.peek.reset();
  assert.deepEqual(a.log, [true, false]);
  assert.equal(a.peek.keyup(K('Alt')), false, 'the later keyup is a no-op');
  const b = setup(); b.peek.keydown(K('Alt')); b.peek.reset(); b.advance(1000);
  assert.deepEqual(b.log, []);
});

test('can peek again after a release; a stray keyup does nothing', () => {
  const { peek, log, advance } = setup();
  assert.equal(peek.keyup(K('Alt')), false);
  for (let i = 0; i < 2; i++) { peek.keydown(K('Alt')); advance(PEEK_DELAY_MS); peek.keyup(K('Alt')); }
  assert.deepEqual(log, [true, false, true, false]);
});

test('the key is configurable; other modifiers are inert, and bad names disable it', () => {
  const { peek, log, advance } = setup('Shift');
  peek.keydown(K('Alt')); advance(1000);
  assert.deepEqual(log, []);
  peek.keyup(K('Alt')); peek.keydown(K('Shift')); advance(PEEK_DELAY_MS);
  assert.deepEqual(log, [true]);
  assert.equal(peekKeyOrNull('Control'), 'Control');
  assert.equal(peekKeyOrNull('off'), null);
  const off = setup(null); off.peek.keydown(K('Alt')); off.advance(1000);
  assert.deepEqual(off.log, []);
});
