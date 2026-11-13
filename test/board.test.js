import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startHatch } from './helpers.js';

const DIR = fileURLToPath(new URL('../examples/widgets/board/', import.meta.url));
const ctx = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(DIR, 'model.js'), 'utf8'), ctx);
const J = (v) => JSON.parse(JSON.stringify(v)); // objects from the vm context have another realm's prototypes
const M = ctx.ScratchModel;

test('cards: add, edit, move, raise and delete (arrows go with the card)', () => {
  let { board, id } = J(M.addCard(M.empty(), 100, 100, 'a'));
  const b2 = J(M.addCard(board, 400, 100, 'b')); board = b2.board;
  board = J(M.setText(board, id, 'hello')); board = J(M.moveCard(board, id, 5.4, 6));
  assert.deepEqual(board.cards.map((c) => [c.id, c.text]), [[id, 'hello'], [b2.id, 'b']]);
  assert.equal(board.cards[0].x, 5);
  const r = J(M.addArrow(board, id, b2.id)); assert.ok(r.id);
  assert.equal(J(M.raise(r.board, id)).cards[1].id, id);
  assert.deepEqual(J(M.removeCard(r.board, id)).arrows, []);
});

test('arrows: no self loops, duplicates or unknown cards; ids never repeat', () => {
  let b = M.empty(); const a = J(M.addCard(b, 0, 0)); const c = J(M.addCard(a.board, 300, 0)); b = c.board;
  assert.equal(M.addArrow(b, a.id, a.id).id, null);
  assert.equal(M.addArrow(b, a.id, 'nope').id, null);
  const one = J(M.addArrow(b, a.id, c.id)); assert.ok(one.id);
  assert.equal(M.addArrow(one.board, a.id, c.id).id, null);
  assert.ok(M.addArrow(one.board, c.id, a.id).id, 'the reverse direction is a different arrow');
  const gone = J(M.removeArrow(one.board, one.id)); assert.deepEqual(gone.arrows, []);
  assert.ok(new Set([a.id, c.id, one.id]).size === 3);
});

test('save format: chunks join to JSON that round-trips, also with non-ASCII text and quotes', () => {
  let { board, id } = J(M.addCard(M.empty(), 10, 10, 'café "q" \\ \u{1F600}\nline2 ' + 'x'.repeat(7000)));
  board = J(M.setView(board, { x: -50, y: 20, zoom: 1.5 }));
  const parts = M.chunks(board, 3000); assert.ok(parts.length >= 3 && parts.every((p) => p.length <= 3000 && /^[\x20-\x7e]*$/.test(p)));
  const back = J(M.parse(parts.join('')));
  assert.deepEqual(back, board); assert.equal(back.cards[0].id, id);
});

test('parse and sanitize: malformed input gives an empty or repaired board, never a throw', () => {
  assert.deepEqual(J(M.parse('{not json')), J(M.empty()));
  assert.deepEqual(J(M.parse('null')), J(M.empty()));
  const b = J(M.sanitize({ cards: [{ id: 'c3', x: 'bad', text: 5 }, { id: 'c3' }, null, { x: 1 }], arrows: [{ id: 'a1', from: 'c3', to: 'zz' }, { id: 'a2', from: 'c3', to: 'c3' }], view: { zoom: 99 } }));
  assert.equal(b.cards.length, 1); assert.equal(b.cards[0].x, 0); assert.equal(b.cards[0].text, '');
  assert.deepEqual(b.arrows, []); assert.equal(b.view.zoom, 3); assert.ok(b.nextId > 3);
});

test('view math: zoomAt keeps the point under the cursor; edge points sit on the border; hit test picks the top card', () => {
  const v = { x: 30, y: -10, zoom: 1 }; const w = M.toWorld(v, 200, 100);
  const z = M.zoomAt(v, 200, 100, 2); const w2 = M.toWorld(z, 200, 100);
  assert.ok(Math.abs(w.x - w2.x) < 1e-9 && Math.abs(w.y - w2.y) < 1e-9 && z.zoom === 2);
  assert.equal(M.zoomAt({ x: 0, y: 0, zoom: 3 }, 0, 0, 5).zoom, 3);
  const card = { x: 0, y: 0, w: 100, h: 50 };
  assert.deepEqual(J(M.edgePoint(card, 500, 25)), { x: 100, y: 25 });
  assert.deepEqual(J(M.edgePoint(card, 50, -500)), { x: 50, y: 0 });
  const b = { cards: [{ id: 'c1', x: 0, y: 0, w: 100, h: 100 }, { id: 'c2', x: 50, y: 50, w: 100, h: 100 }] };
  assert.equal(M.cardAt(b, 60, 60).id, 'c2'); assert.equal(M.cardAt(b, 10, 10).id, 'c1'); assert.equal(M.cardAt(b, 300, 300), null);
});

test('board example: the save and load sources write the file in chunks and read it back', async () => {
  const h = await startHatch();
  try {
    assert.equal((await h.call('POST', '/api/examples/board/open', {})).status, 200);
    const call = async (source, arg) => { const r = await h.call('POST', '/api/call', { widget: 'board', source, arg }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.value; };
    assert.equal((await call('load')).json, null, 'no file yet: null, so the widget starts empty');
    let { board } = J(M.addCard(M.empty(), 10, 10, 'café "q" $HOME `x` ' + 'y'.repeat(7000)));
    const parts = M.chunks(board);
    let r = await call('save', 'B ' + parts[0]); assert.equal(r.code, 0, r.error);
    for (const p of parts.slice(1)) { r = await call('save', 'A ' + p); assert.equal(r.code, 0, r.error); }
    assert.ok(!fs.existsSync(path.join(h.stateDir, 'widgets', 'board', 'data', 'board.json')), 'nothing is live before the commit step');
    await call('save', 'C');
    const back = J(M.sanitize((await call('load')).json));
    assert.deepEqual(back, J(M.sanitize(board)));
    const bad = await h.call('POST', '/api/call', { widget: 'board', source: 'save', arg: 'rm -rf x' });
    assert.equal(bad.data.value.code, 1, 'unknown steps are refused');
  } finally { await h.close(); }
});
