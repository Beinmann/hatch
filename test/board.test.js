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

test('board file: open with a path pins load and save to that file (quotes in the path, new file, bad paths refused)', async () => {
  const h = await startHatch();
  const dir = path.join(h.dir, "it's a dir"); fs.mkdirSync(dir);
  const file = path.join(dir, 'plan.board.json');
  try {
    const open = (f, extra = {}) => h.call('POST', '/api/examples/board/open', { file: f, ...extra });
    const r0 = await open(file); assert.equal(r0.status, 200, JSON.stringify(r0.data));
    const name = r0.data.props.name; assert.equal(name, 'board-plan');
    const call = async (source, arg) => { const r = await h.call('POST', '/api/call', { widget: name, source, arg }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.value; };
    assert.equal((await call('load')).json, null, 'new file: empty board');
    const { board } = J(M.addCard(M.empty(), 10, 10, 'on disk'));
    const parts = M.chunks(board);
    await call('save', 'B ' + parts[0]); for (const p of parts.slice(1)) await call('save', 'A ' + p);
    assert.ok(!fs.existsSync(file), 'not live before the commit step');
    await call('save', 'C');
    assert.deepEqual(J(M.sanitize(JSON.parse(fs.readFileSync(file, 'utf8')))), J(M.sanitize(board)), 'plain JSON in the chosen file');
    assert.deepEqual(J(M.sanitize((await call('load')).json)), J(M.sanitize(board)));
    assert.ok(!fs.existsSync(path.join(h.stateDir, 'widgets', 'board', 'data')), 'the default data dir is untouched');
    // the same file again reuses the widget; another folder with the same file name gets its own
    assert.equal((await open(file)).data.props.name, name);
    const other = path.join(h.dir, 'plan.board.json');
    assert.match((await open(other)).data.props.name, /^board-plan-[0-9a-f]{6}$/);
    // refused: wrong suffix, relative, directory, missing folder, a regular file that is not a board, control characters
    const plain = path.join(h.dir, 'notes.json'); fs.writeFileSync(plain, '{}');
    const link = path.join(h.dir, 'sneaky.board.json'); fs.symlinkSync(plain, link);
    const asDir = path.join(h.dir, 'd.board.json'); fs.mkdirSync(asDir);
    for (const bad of [plain, 'rel.board.json', asDir, path.join(h.dir, 'nodir', 'x.board.json'), link, path.join(h.dir, 'a\nb.board.json'), path.join(h.dir, '.board.json')]) {
      const r = await open(bad); assert.equal(r.status, 400, bad); assert.ok(r.data.error, bad);
    }
    assert.equal(fs.readFileSync(plain, 'utf8'), '{}');
    // a malformed existing file reports a load error (the widget then keeps saving off)
    const broken = path.join(h.dir, 'broken.board.json'); fs.writeFileSync(broken, '{nope');
    const bn = (await open(broken)).data.props.name;
    const lr = (await h.call('POST', '/api/call', { widget: bn, source: 'load' })).data.value; assert.match(lr.error, /not JSON/);
  } finally { await h.close(); }
});

test('hatch widget open board FILE resolves a relative path from the caller and creates the board widget', async () => {
  const { spawn } = await import('node:child_process');
  // async: a sync spawn would freeze the in-process server the CLI talks to
  const run = (args, opts) => new Promise((resolve) => { const c = spawn(process.execPath, args, opts); let stdout = ''; let stderr = ''; c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; }); c.on('close', (status) => resolve({ status, stdout, stderr })); });
  const h = await startHatch();
  try {
    const cwd = fs.mkdtempSync(path.join(h.dir, 'cwd-'));
    const env = { ...process.env, HOME: h.dir }; for (const k of ['HATCH_STATE', 'HATCH_URL', 'HATCH_WORKSPACE']) delete env[k];
    const bin = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
    const r = await run([bin, '--state', h.stateDir, 'w', 'o', 'board', './plan.board.json'], { cwd, env });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /widget board-plan open as w-board-plan/);
    const meta = JSON.parse(fs.readFileSync(path.join(h.stateDir, 'widgets', 'board-plan', 'widget.json'), 'utf8'));
    assert.equal(meta.file, path.join(fs.realpathSync(cwd), 'plan.board.json'));
    const bad = await run([bin, '--state', h.stateDir, 'widget', 'open', 'board', './plan.txt'], { cwd, env });
    assert.equal(bad.status, 1); assert.match(bad.stderr, /\.board\.json/);
    // plain `widget open board` keeps the default behaviour
    const plainOpen = await run([bin, '--state', h.stateDir, 'widget', 'open', 'board'], { cwd, env });
    assert.equal(plainOpen.status, 0, plainOpen.stderr); assert.match(plainOpen.stdout, /widget board open as w-board\b/);
  } finally { await h.close(); }
});

test('checklist: lines parse, progress counts, toggleCheck flips one line and survives bad input', () => {
  const text = 'Todo\n- [ ] one\n  * [x] two\n- [X] three\n-[ ] not a box\n- [] nor this';
  assert.deepEqual(J(M.progress(text)), { done: 2, total: 3 });
  assert.deepEqual(J(M.lines(text).map((l) => l.check)), [null, { checked: false, label: 'one' }, { checked: true, label: 'two' }, { checked: true, label: 'three' }, null, null]);
  const { board, id } = J(M.addCard(M.empty(), 0, 0, text));
  const b1 = J(M.toggleCheck(board, id, 1)); assert.equal(b1.cards[0].text.split('\n')[1], '- [x] one');
  const b2 = J(M.toggleCheck(b1, id, 2)); assert.equal(b2.cards[0].text.split('\n')[2], '  * [ ] two');
  assert.equal(b2.cards[0].text.split('\n')[3], '- [X] three');
  assert.equal(J(M.toggleCheck(b2, id, 3)).cards[0].text.split('\n')[3], '- [ ] three');
  for (const bad of [0, 4, 99, -1, NaN, undefined]) assert.deepEqual(J(M.toggleCheck(board, id, bad)), board);
  assert.deepEqual(J(M.toggleCheck(board, 'nope', 1)), board);
  assert.deepEqual(J(M.progress(undefined)), { done: 0, total: 0 });
  assert.equal(M.toggleCheck(board, id, 1).cards.length, 1);
});

test('node types: untyped cards are sticky notes and round-trip unchanged; bad types and bad board cards are repaired', () => {
  const old = { version: 1, cards: [{ id: 'c1', x: 1, y: 2, w: 180, h: 100, text: 'old' }], arrows: [], view: { x: 0, y: 0, zoom: 1 }, nextId: 2 };
  const b = J(M.sanitize(old)); assert.equal(M.typeOf(b.cards[0]), 'note'); assert.equal('type' in b.cards[0], false);
  assert.deepEqual(J(M.sanitize(b)), b);
  const r = J(M.sanitize({ cards: [
    { id: 'c1', type: 'nope', text: 'x' }, { id: 'c2', type: 'task', status: 'blocked' }, { id: 'c3', type: 'task', status: 'bad' },
    { id: 'c4', type: 'board', childId: '../evil' }, { id: 'c5', type: 'board', childId: 'bab12', count: 3, preview: [[0, 0, 5, 5, 'note'], 'junk'] }, { id: 'c6', type: 'milestone', w: 1, h: 1 }] }));
  assert.deepEqual(r.cards.map((c) => M.typeOf(c)), ['note', 'task', 'task', 'note', 'board', 'milestone']);
  assert.equal(r.cards[1].status, 'blocked'); assert.equal(r.cards[2].status, undefined);
  assert.deepEqual(r.cards[4].preview, [[0, 0, 5, 5, 'note']]); assert.equal(r.cards[5].w, 90);
  const added = J(M.addCard(M.empty(), 0, 0, '', 'code')); assert.equal(added.board.cards[0].type, 'code'); assert.equal(J(M.addCard(M.empty(), 0, 0)).board.cards[0].type, undefined);
});

test('node types: code tinting round-trips, quote source, link and image addresses, group members, frames do not catch arrows', () => {
  const code = 'const a = f(1, "x") // hi\nif (a) { return null }';
  const toks = J(M.tokenize(code)); assert.equal(toks.map((t) => t[1]).join(''), code);
  assert.deepEqual(toks.filter((t) => t[0]).map((t) => t[0] + t[1]), ['kconst', 'ff', 'n1', 's"x"', 'c// hi', 'kif', 'kreturn', 'knull']);
  assert.deepEqual(J(M.splitQuote('wise words\n— someone')), { quote: 'wise words', source: 'someone' });
  assert.deepEqual(J(M.splitQuote('- not a source')), { quote: '- not a source', source: '' });
  assert.equal(M.linkUrl('javascript:alert(1)'), ''); assert.equal(M.linkUrl('https://example.org/a'), 'https://example.org/a');
  assert.equal(M.imageUrl('https://example.org/a.png'), 'https://example.org/a.png'); assert.equal(M.imageUrl('https://example.org/page'), '');
  assert.equal(M.cycle(['a', 'b', 'c'], 'c'), 'a');
  const b = { cards: [{ id: 'g', type: 'group', x: 0, y: 0, w: 300, h: 300 }, { id: 'in', x: 10, y: 10, w: 50, h: 50 }, { id: 'half', x: 280, y: 10, w: 50, h: 50 }], arrows: [] };
  assert.deepEqual(J(M.groupMembers(b, 'g')), ['in']);
  assert.equal(M.cardAt(b, 20, 20).id, 'in'); assert.equal(M.cardAt(b, 200, 200).id, 'g');
});

test('nested boards: wrap moves cards and inner arrows into a child, paste remaps ids and refuses loops, summary follows the child', () => {
  let b = M.empty(); const ids = [];
  for (const x of [0, 300, 600]) { const r = J(M.addCard(b, x, 0, 't' + x)); b = r.board; ids.push(r.id); }
  b = J(M.addArrow(b, ids[0], ids[1])).board; b = J(M.addArrow(b, ids[1], ids[2])).board;
  const w = J(M.wrap(b, [ids[0], ids[1]], 'Inner', () => 0.5));
  assert.deepEqual(w.board.cards.map((c) => M.typeOf(c)).sort(), ['board', 'note']);
  assert.deepEqual(w.board.arrows, [], 'the arrow to the card that stayed is dropped');
  assert.equal(w.child.cards.length, 2); assert.equal(w.child.arrows.length, 1);
  const card = w.board.cards.find((c) => c.id === w.id); assert.equal(card.count, 2); assert.equal(card.preview.length, 2); assert.match(card.childId, /^b[a-z0-9]{10}$/);
  assert.equal(M.wrap(b, [], 'x'), null);
  // paste: fresh ids, relative layout, arrows between pasted cards kept
  const clip = J(M.clip(w.child, w.child.cards.map((c) => c.id)));
  const p = J(M.paste(M.empty(), clip, 100, 100)); assert.equal(p.board.cards.length, 2); assert.equal(p.board.arrows.length, 1);
  assert.equal(Math.min(...p.board.cards.map((c) => c.x)), 100);
  assert.deepEqual(new Set(p.board.arrows.map((a) => a.from)).size, 1);
  // a board card whose child is open above is refused (and reported), others still go through
  const loop = J(M.paste(M.empty(), J(M.clip(w.board, [w.id, w.board.cards.find((c) => c.id !== w.id).id])), 0, 0, [card.childId]));
  assert.deepEqual(loop.refused, [w.id]); assert.equal(loop.board.cards.length, 1);
  assert.equal(M.wouldCycle(['b1', 'b2'], 'b2'), true); assert.equal(M.wouldCycle(['b1'], 'b3'), false);
  // the summary of the card follows the child
  const grown = J(M.addCard(w.child, 0, 0, 'more')).board; assert.equal(J(M.setChildSummary(w.board, w.id, grown)).cards.find((c) => c.id === w.id).count, 3);
});

test('nested board storage: child boards live next to the file (or in the data dir), ids cannot escape, root protocol is unchanged', async () => {
  const h = await startHatch();
  const file = path.join(h.dir, 'plan.board.json');
  try {
    for (const open of [() => h.call('POST', '/api/examples/board/open', {}), () => h.call('POST', '/api/examples/board/open', { file })]) {
      const r = await open(); assert.equal(r.status, 200, JSON.stringify(r.data));
      const name = r.data.props.name;
      const call = async (source, arg) => { const x = await h.call('POST', '/api/call', { widget: name, source, arg }); assert.equal(x.status, 200, JSON.stringify(x.data)); return x.data.value; };
      assert.equal((await call('load', 'bchild1')).json, null, 'an unwritten child is empty');
      const { board } = J(M.addCard(M.empty(), 0, 0, 'inside'));
      const parts = M.chunks(board);
      await call('save', 'B:bchild1 ' + parts[0]); for (const p of parts.slice(1)) await call('save', 'A:bchild1 ' + p); await call('save', 'C:bchild1');
      assert.equal(J(M.sanitize((await call('load', 'bchild1')).json)).cards[0].text, 'inside');
      assert.equal((await call('load')).json, null, 'the root is a different file');
      const where = (await call('path', 'bchild1')).out;
      assert.ok(where.endsWith(name === 'board' ? 'board.bchild1.json' : 'plan.bchild1.board.json'), where);
      assert.ok(fs.existsSync(where));
      assert.equal(path.dirname(where), path.dirname((await call('path')).out), 'next to the parent');
      const bad = await call('save', 'B:../x ' + parts[0]); assert.equal(bad.code, 1);
      assert.equal((await h.call('POST', '/api/call', { widget: name, source: 'load', arg: 'a.b' })).data.value.code, 1, 'dots are not allowed in ids');
    }
  } finally { await h.close(); }
});
