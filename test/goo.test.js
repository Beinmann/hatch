import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../public/fx/goo-physics.js';
import { terminalAdapter } from '../public/fx-terminal.js';

// Deterministic "random" so the physics tests do not flake.
const seeded = (seed = 7) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const run = (d, secs, H = 600, dt = 1 / 30) => { for (let t = 0; t < secs && !d.done; t += dt) G.stepDrip(d, dt, H); return d; };

test('goo level and counts: 50 is the default, 0 means no drips, empty or odd canvases give finite counts', () => {
  assert.deepEqual(G.gooLevel(50), { count: 1, alpha: 1 });
  assert.equal(G.gooLevel(0).count, 0); assert.ok(G.gooLevel(100).count === 2 && G.gooLevel(100).alpha > 1); assert.deepEqual(G.gooLevel(NaN), G.gooLevel(50));
  const lv = G.gooLevel(50);
  for (const [w, h] of [[0, 0], [1, 1], [NaN, 5], [-3, 10], [1920, 1080], [1e6, 1e6]]) { const n = G.maxDrips(w, h, lv); assert.ok(Number.isInteger(n) && n >= 0, `${w}x${h}`); }
  assert.equal(G.maxDrips(0, 0, lv), 0); assert.equal(G.maxDrips(800, 600, G.gooLevel(0)), 0);
  assert.ok(G.maxDrips(800, 600, G.gooLevel(100)) > G.maxDrips(800, 600, G.gooLevel(50)) && G.maxDrips(800, 600, G.gooLevel(50)) > G.maxDrips(800, 600, G.gooLevel(10)));
});

test('goo anchors: blanks never, feet of letters over high marks, taken cells are skipped, nothing to pick gives null', () => {
  assert.equal(G.anchorWeight(''), 0); assert.equal(G.anchorWeight(' '), 0); assert.ok(G.anchorWeight('g') > G.anchorWeight('"')); assert.ok(G.anchorWeight('_') > G.anchorWeight('a')); assert.ok(G.anchorWeight('─') < 1);
  assert.equal(G.pickAnchor([], Math.random), null); assert.equal(G.pickAnchor(null, Math.random), null);
  const cells = [{ col: 0, row: 0, ch: 'a' }, { col: 1, row: 0, ch: 'b' }];
  const rand = seeded(); const seen = new Set(); for (let i = 0; i < 40; i++) seen.add(G.pickAnchor(cells, rand).col); assert.deepEqual([...seen].sort(), [0, 1]);
  for (let i = 0; i < 20; i++) assert.equal(G.pickAnchor(cells, rand, new Set(['0,0'])).col, 1);
  assert.equal(G.pickAnchor(cells, rand, new Set(['0,0', '1,0'])), null);
  const o = G.cellOrigin({ col: 2, row: 3 }, { w: 10, h: 20, left: 5, top: 7 }, 0.5); assert.equal(o.x, 5 + 25); assert.ok(o.y > 7 + 3 * 20 && o.y < 7 + 4 * 20, 'inside the cell, near its foot');
  const f = G.fallbackOrigin(500, 300, rand); assert.ok(f.x >= 0 && f.x <= 500 && f.y > 0 && f.y < 60);
  assert.ok(Number.isFinite(G.fallbackOrigin(0, 0, rand).y));
});

test('goo drip: grows with an eased, accelerating-then-slowing length and an end drop that only forms late, then hangs', () => {
  const d = G.newDrip(100, 50, 600, seeded(3)); d.lets = false; d.hold = 5;
  const lens = []; const beads = [];
  for (let i = 0; i < d.growT * 30 && d.phase === 'grow'; i++) { G.stepDrip(d, 1 / 30, 600); lens.push(d.len); beads.push(d.beadR); }
  assert.ok(lens.every((v, i) => i === 0 || v >= lens[i - 1]), 'never shrinks while growing'); assert.ok(beads.every((v, i) => i === 0 || v >= beads[i - 1] - 1e-9), 'the bead swells');
  assert.equal(beads[Math.floor(beads.length * 0.7)], 0, 'no end drop for most of the growth'); assert.ok(beads.at(-1) > 0.9 * d.beadMax, 'it forms at the end');
  const n = lens.length, v = (a, b) => lens[b] - lens[a];
  assert.ok(v(Math.floor(n * 0.4), Math.floor(n * 0.5)) > v(1, Math.floor(n * 0.1)) && v(Math.floor(n * 0.4), Math.floor(n * 0.5)) > v(Math.floor(n * 0.9), n - 1), 'quicker in the middle than at the start or the end');
  assert.equal(d.phase, 'hang'); assert.ok(Math.abs(d.len - d.maxLen) < 1e-6); assert.ok(d.fade > 0.99, 'faded in');
  assert.ok(d.width >= 1.4 && d.width <= 2.6 && d.beadMax >= 1.3 && d.beadMax <= 2.4); assert.ok(d.beadMax < d.width * 1.5, 'the end drop is small next to the strand');
});

test('goo drip: one that does not let go recedes and ends; one that lets go thins its neck first and falls only once the neck is gone', () => {
  const a = G.newDrip(100, 50, 600, seeded(5)); a.lets = false; a.hold = 0.5; run(a, a.growT + 0.6); assert.equal(a.phase, 'recede'); run(a, 8); assert.equal(a.done, true);
  const b = G.newDrip(100, 50, 600, seeded(6)); b.lets = true; b.hold = 0.5; b.fallLimit = Infinity; run(b, b.growT + 0.6);
  assert.equal(b.phase, 'pinch', 'after the hold the neck thins; nothing falls yet'); assert.equal(b.bv, 0);
  let prev = 1; while (b.phase === 'pinch') { G.stepDrip(b, 1 / 30, 600); assert.ok(b.neck <= prev + 1e-9, 'the neck only gets thinner'); prev = b.neck; assert.ok(b.phase !== 'fall' || b.neck <= 0.02, 'it separates only with the neck gone'); }
  assert.equal(b.phase, 'fall'); const y0 = b.by, ys = [], len0 = b.len;
  for (let i = 0; i < 10; i++) { G.stepDrip(b, 1 / 30, 600); ys.push(b.by); }
  assert.ok(ys[9] - ys[8] > ys[1] - ys[0], 'the drop falls faster and faster'); assert.ok(b.by > y0 && b.len < len0 * 0.8, 'the separated strand pulls together into a drop'); assert.ok(b.stub >= 0 && G.stubOf(b) !== null || b.stub < 0.5);
  run(b, 20); assert.equal(b.done, true, 'leaves the canvas and ends');
  const c = G.newDrip(100, 50, 600, seeded(8)); c.fallLimit = 30; c.lets = true; c.hold = 0.1; c.pinchT = 0.2; run(c, c.growT + 0.2); let faded = false; for (let i = 0; i < 200 && !c.done; i++) { G.stepDrip(c, 1 / 30, 600); if (c.beadFade < 1 && c.by < 600) faded = true; } assert.ok(faded, 'a drop fades out after its fall limit');
});

test('goo drip: length is capped, the default drip count is much higher, and the neck only pinches off for drips that let go', () => {
  const rand = seeded(21); let longest = 0, shortest = Infinity;
  for (let i = 0; i < 300; i++) { const d = G.newDrip(10, 10, 5000, rand); longest = Math.max(longest, d.maxLen); shortest = Math.min(shortest, d.maxLen); run(d, d.growT + 1); assert.ok(d.len <= G.CFG.LEN[1] + 1e-6, 'never grows past the cap'); }
  assert.ok(longest > 150 && longest <= G.CFG.LEN[1], `long but limited (${longest})`); assert.ok(shortest >= G.CFG.LEN[0]);
  assert.ok(G.maxDrips(1280, 800, G.gooLevel(50)) >= 60, 'many drips by default');
  const hold = G.newDrip(10, 10, 600, seeded(2)); hold.lets = true; hold.hold = 1000; run(hold, hold.growT + 30); assert.equal(hold.phase, 'hang', 'a drip that is still held on to the text does not fall');
  const strands = G.newDrip(10, 10, 600, seeded(3)); strands.lets = true; strands.hold = 0.1; strands.pinchT = 4; run(strands, strands.growT + 0.1 + 2); const mid = G.strandPoints(strands);
  assert.equal(strands.phase, 'pinch'); assert.ok(mid[0].w < strands.width * 0.6 && mid.at(-1).w > 0.3, 'the strand thins at the text, not at the drop');
});

test('goo drip: sway is zero at the root, grows toward the tip and stays small; strand points taper and are finite', () => {
  const d = G.newDrip(100, 50, 600, seeded(9)); d.maxLen = 100; d.len = 100; d.age = 3.3;
  assert.equal(G.swayAt(d, 0), 0); assert.ok(Math.abs(G.swayAt(d, 1)) <= d.swayAmp + 1e-9);
  const p = G.strandPoints(d); assert.ok(p.length >= 3); assert.equal(p[0].y, 50); assert.ok(p.at(-1).w < p[0].w, 'thinner at the tip'); assert.ok(p.every((q) => Number.isFinite(q.x + q.y + q.w) && q.w > 0));
  assert.ok(Math.abs(p[0].x - 100) < 1e-9); assert.deepEqual(G.strandPoints({ ...d, len: 0 }), []); assert.deepEqual(G.strandPoints({ ...d, len: NaN }), []);
  const t = G.tipOf(d); assert.equal(t.y, 150);
});

test('goo scrolling: anchored drips move with their line, are released when it leaves the screen or the character is gone, fixed ones ignore it', () => {
  const mk = (row, ch = 'x') => { const d = G.newDrip(10, 10, 600, seeded(row + 1), { col: 3, row, ch, fx: 0.5 }); run(d, d.growT * 0.5); return d; };
  const a = mk(10), b = mk(1), c = mk(5), fixed = G.newDrip(10, 10, 600, seeded(2)); run(fixed, 2);
  const released = G.scrollDrips([a, b, c, fixed], 3, 24);
  assert.equal(released, 1); assert.equal(a.anchor.row, 7); assert.equal(c.anchor.row, 2); assert.equal(b.anchor, null); assert.equal(b.phase, 'fall'); assert.equal(fixed.phase === 'fall', false);
  assert.equal(G.scrollDrips([a], 0, 24), 0); assert.equal(G.scrollDrips([a], NaN, 24), 0);
  assert.equal(G.scrollDrips([a], -20, 24), 1, 'scrolling down far moves the cell off the bottom'); 
  const grid = { '3,2': 'x', '3,7': 'y' }; const live = [mk(2), mk(7)];
  assert.equal(G.checkAnchors(live, (col, row) => grid[`${col},${row}`] || ''), 1); assert.equal(live[0].anchor !== null, true); assert.equal(live[1].phase, 'fall', 'the letter changed: it lets go');
  const moved = mk(4); G.placeDrips([moved], { w: 10, h: 20, left: 0, top: 0 }); assert.equal(moved.ox, 35); assert.ok(moved.oy > 80 && moved.oy < 100);
  const f = mk(4); G.release(f); const ox = f.ox; G.placeDrips([f], { w: 99, h: 99, left: 0, top: 0 }); assert.equal(f.ox, ox, 'a released drip keeps its last position');
});

// ---- the drawing module, against a stub canvas and a fake terminal view ----
const stubEnv = () => {
  const calls = {}, bad = [];
  const finite = (a) => a.every((v) => typeof v !== 'number' || Number.isFinite(v));
  const ctx2d = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => { calls[k] = (calls[k] || 0) + 1; if (!finite(a)) bad.push([k, a]); return String(k).startsWith('create') ? { addColorStop() {} } : undefined; }), set: (t, k, v) => { t[k] = v; return true; } });
  const canvas = (w, h) => ({ clientWidth: w, clientHeight: h, width: 0, height: 0, getContext: () => ctx2d() });
  const saved = { document: globalThis.document, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  const st = { queued: null };
  globalThis.document = { hidden: false }; globalThis.requestAnimationFrame = (f) => { st.queued = f; return 1; }; globalThis.cancelAnimationFrame = () => {};
  const restore = () => { Object.assign(globalThis, { document: saved.document, requestAnimationFrame: saved.raf, cancelAnimationFrame: saved.caf }); if (!saved.document) delete globalThis.document; };
  return { calls, bad, canvas, st, restore };
};
const fakeTerm = (text = ['hello goo world', '', 'second line here']) => {
  const t = { cols: 40, rows: 10, vy: 0, lines: text, listeners: new Set(), disposed: 0 };
  t.cellSize = () => ({ w: 10, h: 20, left: 4, top: 2 }); t.viewportY = () => t.vy;
  t.charAt = (c, r) => { const ch = t.lines[r]?.[c] ?? ''; return ch === ' ' ? '' : ch; };
  t.cellsWithText = () => { const o = []; t.lines.forEach((l, r) => [...l].forEach((ch, c) => { if (ch !== ' ') o.push({ col: c, row: r, ch }); })); return o; };
  t.onChange = (cb) => { t.listeners.add(cb); return () => { t.listeners.delete(cb); t.disposed++; }; }; t.fire = () => { for (const f of t.listeners) f(); };
  return t;
};

test('goo runs against a stub canvas: without a terminal, with one, with no text, 0x0 canvas, any intensity; nothing non-finite reaches the canvas', async () => {
  const env = stubEnv();
  try {
    const goo = (await import('../public/fx/goo.js')).default;
    assert.equal(goo.name, 'goo'); for (const fn of ['start', 'stop', 'resize', 'setIntensity']) assert.equal(typeof goo[fn], 'function');
    for (const [w, h] of [[0, 0], [1, 1], [640, 400]]) {
      for (const terminal of [undefined, null, fakeTerm(), fakeTerm([]), fakeTerm([''])]) {
        const c = env.canvas(w, h);
        goo.start(c, { animate: false, intensity: 50, terminal }); assert.ok(c.width >= 1 && c.height >= 1); goo.resize(); goo.setIntensity(100); goo.setIntensity(0); goo.stop();
        goo.start(c, { animate: true, intensity: 80, terminal }); for (let t = 100; t < 3000; t += 33) env.st.queued(t); goo.setIntensity(20); for (let t = 3000; t < 3300; t += 33) env.st.queued(t); goo.resize(); goo.stop();
      }
    }
    assert.deepEqual(env.bad, [], 'no NaN or Infinity reached the canvas'); assert.ok(env.calls.clearRect > 0);
    assert.ok(env.calls.ellipse > 0 && env.calls.fill > 0 && env.calls.stroke > 0, 'it drew strands and beads');
  } finally { env.restore(); }
});

test('goo anchors to the terminal: drips start at text cells, follow scrolling, let go when the text is gone, and unsubscribe on stop', async () => {
  const env = stubEnv(); const origRandom = Math.random; let s = 11; Math.random = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  try {
    const goo = (await import('../public/fx/goo.js')).default; const term = fakeTerm(); const c = env.canvas(500, 300);
    goo.start(c, { animate: true, intensity: 100, terminal: term }); assert.equal(term.listeners.size, 1, 'subscribed to screen changes');
    for (let t = 100; t < 6000; t += 33) env.st.queued(t); assert.ok(env.calls.ellipse > 0, 'drips drew with a terminal');
    // fall-back check: with the text gone, a change event releases everything and no new drips start; the canvas ends up empty
    term.lines = []; term.fire(); const before = env.calls.ellipse; for (let t = 6000; t < 30000; t += 33) env.st.queued(t);
    const afterGone = env.calls.ellipse - before; env.calls.ellipse = 0; for (let t = 30000; t < 31000; t += 33) env.st.queued(t); assert.equal(env.calls.ellipse, 0, `nothing left to draw once the drips fell away (drew ${afterGone} while they fell)`);
    term.lines = ['new text on screen']; term.vy = 3; term.fire(); for (let t = 31000; t < 40000; t += 33) env.st.queued(t); assert.ok(env.calls.ellipse > 0, 'new text gets new drips');
    goo.stop(); assert.equal(term.listeners.size, 0); assert.equal(term.disposed, 1);
  } finally { Math.random = origRandom; env.restore(); }
});

// ---- the terminal view around xterm ----
const fakeXterm = (lines, vy = 0) => {
  const cell = (ch) => ({ getChars: () => ch });
  const handlers = {}; const ev = (name) => (cb) => { (handlers[name] ||= []).push(cb); return { dispose() { handlers[name] = handlers[name].filter((f) => f !== cb); } }; };
  const x = {
    cols: 12, rows: 4, handlers, element: { querySelector: (q) => (q === '.xterm-screen' ? { getBoundingClientRect: () => ({ left: 14, top: 12, width: 120, height: 80 }) } : null) },
    onRender: ev('r'), onScroll: ev('s'), onResize: ev('z'),
    buffer: { active: { viewportY: vy, getNullCell: () => cell(''), getLine: (i) => (lines[i] === undefined ? undefined : { length: 12, getCell: (c) => cell(lines[i][c] ?? '') }) } },
  };
  return x;
};

test('terminal view: cell size from the DOM relative to the canvas, text cells with the viewport offset, throttled change events, dispose', async () => {
  const x = fakeXterm(['ab', '', ' c d', 'z'], 0); const canvas = { getBoundingClientRect: () => ({ left: 10, top: 10 }) };
  const t = terminalAdapter(x, canvas);
  assert.deepEqual(t.cellSize(), { w: 10, h: 20, left: 4, top: 2 }); assert.equal(t.cols, 12); assert.equal(t.rows, 4); assert.equal(t.viewportY(), 0);
  assert.deepEqual(t.cellsWithText().map((c) => `${c.col},${c.row},${c.ch}`), ['0,0,a', '1,0,b', '1,2,c', '3,2,d', '0,3,z']);
  assert.equal(t.cellsWithText(2).length, 2, 'capped'); assert.equal(t.charAt(1, 2), 'c'); assert.equal(t.charAt(0, 2), ''); assert.equal(t.charAt(5, 1), '');
  x.buffer.active.viewportY = 2; assert.equal(t.viewportY(), 2); assert.equal(t.charAt(0, 0), '', 'row 0 is the first visible row: the buffer line viewportY + 0 = " c d"'); assert.equal(t.charAt(1, 0), 'c');
  { const bare = terminalAdapter({ ...x, element: null }, canvas); assert.equal(bare.cellSize().w, 0, 'no screen element: not measurable, not NaN'); bare.dispose(); }
  let n = 0; const off = t.onChange(() => n++);
  for (const h of x.handlers.r) h(); for (const h of x.handlers.s) h(); for (const h of x.handlers.z) h();
  assert.equal(n, 1, 'a burst of render/scroll/resize events gives one call now (the rest wait for the throttle)');
  await new Promise((r) => setTimeout(r, 260)); assert.equal(n, 2, 'and one trailing call'); off(); for (const h of x.handlers.r) h(); await new Promise((r) => setTimeout(r, 260)); assert.equal(n, 2);
  t.dispose(); assert.equal(x.handlers.r.length + x.handlers.s.length + x.handlers.z.length, 0);
});
