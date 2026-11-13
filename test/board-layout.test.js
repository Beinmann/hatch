import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../examples/widgets/board/', import.meta.url));
const ctx = vm.createContext({});
for (const f of ['model.js', 'layout.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx);
const J = (v) => JSON.parse(JSON.stringify(v));
const M = ctx.ScratchModel, L = ctx.BoardLayout;

const card = (id, x = 0, y = 0, w = 180, h = 100) => ({ id, x, y, w, h, text: id });
const arrow = (from, to) => ({ id: `${from}-${to}`, from, to });
const board = (cards, arrows = []) => ({ version: 1, cards, arrows, view: { x: 0, y: 0, zoom: 1 }, nextId: 99 });
const overlaps = (cs) => cs.some((a, i) => cs.slice(i + 1).some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
const at = (b, id) => b.cards.find((c) => c.id === id);

test('layout: a chain flows left to right with a gap, no overlap', () => {
  const b = J(L.layout(board([card('a'), card('b'), card('c')], [arrow('a', 'b'), arrow('b', 'c')])));
  assert.ok(at(b, 'a').x + 180 + L.GAP_X <= at(b, 'b').x && at(b, 'b').x + 180 + L.GAP_X <= at(b, 'c').x);
  assert.ok(!overlaps(b.cards));
});

test('layout: siblings are stacked in one column, using real card heights', () => {
  const b = J(L.layout(board([card('r'), card('a', 0, 0, 180, 300), card('b', 0, 0, 180, 50)], [arrow('r', 'a'), arrow('r', 'b')])));
  assert.equal(at(b, 'a').x, at(b, 'b').x);
  assert.ok(!overlaps(b.cards));
  assert.ok(Math.abs(at(b, 'a').y - at(b, 'b').y) >= 50 + L.GAP_Y - 1);
});

test('layout: a join (diamond) puts the sink after the longest path; cycles do not hang', () => {
  const d = J(L.layout(board([card('a'), card('b'), card('c'), card('d')], [arrow('a', 'b'), arrow('b', 'c'), arrow('a', 'c'), arrow('c', 'd')])));
  assert.ok(at(d, 'c').x > at(d, 'b').x && at(d, 'd').x > at(d, 'c').x);
  const cyc = J(L.layout(board([card('a'), card('b'), card('c')], [arrow('a', 'b'), arrow('b', 'c'), arrow('c', 'a')])));
  assert.ok(!overlaps(cyc.cards) && at(cyc, 'a').x < at(cyc, 'b').x && at(cyc, 'b').x < at(cyc, 'c').x);
});

test('layout: unconnected cards form a grid below the graph, nothing overlaps, sizes and arrows are kept', () => {
  const cs = [card('a'), card('b'), ...['x1', 'x2', 'x3', 'x4', 'x5'].map((i) => card(i, 5, 5, 200, 80))];
  const b = J(L.layout(board(cs, [arrow('a', 'b')])));
  assert.ok(!overlaps(b.cards));
  for (const i of ['x1', 'x2', 'x3', 'x4', 'x5']) assert.ok(at(b, i).y >= at(b, 'a').y + 100, 'loose cards start below the graph');
  assert.ok(new Set(['x1', 'x2', 'x3', 'x4', 'x5'].map((i) => at(b, i).y)).size >= 2, 'a grid has several rows');
  assert.deepEqual(b.arrows, cs.length && [arrow('a', 'b')]); assert.equal(at(b, 'x1').w, 200);
});

test('layout: many cards on the origin (no arrows) and a big random graph never overlap', () => {
  assert.ok(!overlaps(J(L.layout(board(Array.from({ length: 30 }, (_, i) => card('c' + i))))).cards));
  let s = 7; const r = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const cs = Array.from({ length: 60 }, (_, i) => card('n' + i, 0, 0, 100 + Math.floor(r() * 200), 50 + Math.floor(r() * 200)));
  const ar = []; for (let i = 0; i < 80; i++) { const f = 'n' + Math.floor(r() * 60), t = 'n' + Math.floor(r() * 60); if (f !== t && !ar.some((a) => a.from === f && a.to === t)) ar.push(arrow(f, t)); }
  assert.ok(!overlaps(J(L.layout(board(cs, ar))).cards));
  assert.deepEqual(J(L.layout(board([]))), J(board([])));
});

test('layout: long chains do not overflow the stack; the old top-left corner is kept', () => {
  const cs = Array.from({ length: 5000 }, (_, i) => card('n' + i, 400, 300)), ar = cs.slice(1).map((c, i) => arrow('n' + i, c.id));
  const b = J(L.layout(board(cs, ar))); assert.equal(at(b, 'n0').x, 400);
  assert.ok(at(b, 'n4999').x > at(b, 'n0').x);
});

test('onLoad: missing positions or a pile at the origin are laid out; a user-arranged board is left alone', () => {
  const raw = { cards: [{ id: 'c1', text: 'a' }, { id: 'c2', text: 'b' }, { id: 'c3', text: 'c' }], arrows: [{ id: 'a1', from: 'c1', to: 'c2' }] };
  const r = J(L.onLoad(raw, M.sanitize(raw))); assert.ok(r.changed && !overlaps(r.board.cards) && at(r.board, 'c2').x > at(r.board, 'c1').x);
  const pile = { cards: [card('c1'), card('c2'), card('c3')], arrows: [] };
  assert.ok(J(L.onLoad(pile, M.sanitize(pile))).changed);
  const mine = { cards: [card('c1', 0, 0), card('c2', 500, 0), card('c3', 100, 50), card('c4', 900, 900), card('c5', 0, 500), card('c6', 1200, 0)], arrows: [] };
  const san = M.sanitize(mine), res = J(L.onLoad(mine, san)); assert.equal(res.changed, false); assert.deepEqual(res.board, J(san));
  const one = { cards: [card('c1')], arrows: [] }; assert.equal(L.onLoad(one, M.sanitize(one)).changed, false);
});

test('onLoad: only the cards without a position are placed, below the arranged ones', () => {
  const raw = { cards: [card('c1', 100, 100), card('c2', 600, 100), { id: 'c3', text: 'new' }, { id: 'c4', text: 'new' }], arrows: [] };
  const r = J(L.onLoad(raw, M.sanitize(raw)));
  assert.ok(r.changed); assert.equal(at(r.board, 'c1').x, 100); assert.equal(at(r.board, 'c2').x, 600);
  assert.ok(at(r.board, 'c3').y >= 200 && !overlaps(r.board.cards));
});

test('snapshot and restore: one step back to the earlier positions, extra or removed cards are tolerated', () => {
  const b = board([card('a', 10, 20), card('b', 30, 40)], [arrow('a', 'b')]);
  const snap = L.snapshot(b), t = L.layout(b);
  assert.deepEqual(J(L.restore(t, snap)), J(b));
  assert.equal(J(L.restore(M.removeCard(t, 'b'), snap)).cards.length, 1);
});

// Arrow paths: after tidy no arrow may run through another card or lie on top of another arrow.
const sampleArrow = (p) => Array.from({ length: 41 }, (_, i) => { const u = i / 40, v = 1 - u, c = p.c || { x: (p.x1 + p.x2) / 2, y: (p.y1 + p.y2) / 2 };
  return { x: v * v * p.x1 + 2 * v * u * c.x + u * u * p.x2, y: v * v * p.y1 + 2 * v * u * c.y + u * u * p.y2 }; });
const crossesOther = (b, a) => { const p = M.arrowPath(b, a); return b.cards.some((c) => c.id !== a.from && c.id !== a.to && sampleArrow(p).some((q) => q.x > c.x && q.x < c.x + c.w && q.y > c.y && q.y < c.y + c.h)); };

test('arrowPath: a plain arrow stays a straight line', () => {
  const b = board([card('a', 0, 0), card('b', 300, 0)], [arrow('a', 'b')]);
  assert.equal(M.arrowPath(b, b.arrows[0]).c, null);
});

test('arrowPath: an arrow that would pass through another card curves around it', () => {
  const b = board([card('a', 0, 0), card('m', 270, 0), card('c', 540, 0)], [arrow('a', 'c')]);
  const p = M.arrowPath(b, b.arrows[0]);
  assert.ok(p.c, 'curved');
  assert.ok(!crossesOther(b, b.arrows[0]));
});

test('tidy keeps a three-card cycle readable: the back arrow does not cross the middle card or coincide with another arrow', () => {
  const b = J(L.layout(board([card('h', 0, 0), card('w', 300, 200), card('t', 600, 0)], [arrow('h', 'w'), arrow('w', 't'), arrow('t', 'h')])));
  const ys = new Set(b.cards.map((c) => c.y));
  for (const a of b.arrows) assert.ok(!crossesOther(b, a), `${a.id} crosses a card`);
  const back = M.arrowPath(b, b.arrows.find((a) => a.id === 't-h'));
  assert.ok(back.c || ys.size > 1, 'back arrow is curved (or the cards are not in one row)');
  // no two arrows share a straight route
  const key = (a) => { const p = M.arrowPath(b, a); return JSON.stringify([p.x1, p.y1, p.x2, p.y2].map(Math.round)); };
  assert.equal(new Set(b.arrows.map(key)).size, b.arrows.length);
});

test('arrowPath: two opposite arrows between the same cards are drawn apart', () => {
  const b = board([card('a', 0, 0), card('b', 300, 0)], [arrow('a', 'b'), arrow('b', 'a')]);
  const [p, q] = b.arrows.map((a) => M.arrowPath(b, a));
  assert.ok(p.c && q.c && Math.sign(p.c.y - 50) !== Math.sign(q.c.y - 50));
});
