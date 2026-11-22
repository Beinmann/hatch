import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startHatch } from './helpers.js';

const DIR = fileURLToPath(new URL('../examples/widgets/tide/', import.meta.url));
const ctx = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(DIR, 'model.js'), 'utf8'), ctx);
const J = (v) => JSON.parse(JSON.stringify(v)); // objects from the vm context have another realm's prototypes
const M = ctx.TideModel;

/** A day with some cards: ids a..f, all 30 minutes unless given; placed ones start at the minute given. */
function day(cards) {
  let st = J(M.empty('2026-01-05'));
  for (const [id, len, s] of cards) st.cards.push({ id, t: id, cat: null, len, s: s ?? null, x: 0, y: 0 });
  st.seq = 50; return st;
}
const starts = (st) => Object.fromEntries(st.cards.filter((c) => c.s !== null).map((c) => [c.id, c.s]));

test('sanitize: any JSON becomes a valid state, bad fields are dropped, ids stay unique', () => {
  const st = J(M.sanitize({ day: '2026-01-05', wall: 99999, cards: [
    { id: 'a', t: 'x'.repeat(500), len: 31, s: 61, cat: 'nope', locked: true, done: 1, steps: ['one', '', 3] },
    { id: 'a', t: 'dup' }, { id: 'b c' }, { t: 'no id' }, null, { id: 'l', s: null, locked: true, x: 'zzz', len: 1 },
  ], goals: [{ id: 'g1', t: 'goal' }], cats: [{ id: 'k', name: '', color: 'red' }] }));
  assert.equal(st.wall, 1440); assert.equal(st.cards.length, 2);
  const a = st.cards[0]; assert.equal(a.t.length, 300); assert.equal(a.len, 30); assert.equal(a.s, 60); assert.equal(a.cat, null); assert.deepEqual(a.steps, ['one']);
  assert.equal(st.cards[1].locked, undefined, 'a loose card cannot be locked'); assert.equal(st.cards[1].len, 15);
  assert.deepEqual(st.cats, [{ id: 'k', name: 'k', color: '#93a4a9' }]);
  assert.equal(J(M.sanitize(null, '2026-02-01')).day, '2026-02-01'); assert.equal(J(M.sanitize('junk')).cards.length, 0);
});

test('place: snaps to 15 minutes, shoves later cards right and keeps gaps', () => {
  let st = day([['a', 30, 600], ['b', 30, 630], ['c', 60, 720], ['d', 30]]);
  st = J(M.place(st, 'd', 604)); // 603 snaps to 600: lands on a (earlier centre goes first)
  assert.deepEqual(starts(st), { a: 600, d: 630, b: 660, c: 720 }, 'a stays, d goes behind it, b is pushed, c keeps its gap');
  st = J(M.place(st, 'd', 586)); assert.equal(starts(st).d, 585, 'snapped to the quarter hour'); assert.equal(starts(st).a, 615, 'a is centred later, so it is pushed behind d'); assert.equal(starts(st).b, 660);
  assert.ok(Object.values(starts(st)).every((s) => s % 15 === 0));
});

test('locked cards never move; others jump over them; a locked card refuses to be placed', () => {
  let st = day([['a', 60, 600], ['b', 30], ['c', 30, 660]]);
  st = J(M.setLocked(st, 'a', true)); st = J(M.place(st, 'b', 615));
  assert.equal(starts(st).a, 600); assert.equal(starts(st).b, 660, 'b is behind the locked block'); assert.equal(starts(st).c, 690);
  assert.equal(M.place(st, 'a', 0), st, 'placing a locked card changes nothing');
  assert.equal(J(M.setLocked(day([['x', 30]]), 'x', true)).cards[0].locked, undefined, 'only placed cards can be locked');
});

test('done cards stay where they are and do not push anything', () => {
  let st = day([['a', 60, 600], ['b', 30]]); st = J(M.toggleDone(st, 'a'));
  st = J(M.place(st, 'b', 615)); assert.equal(starts(st).a, 600); assert.equal(starts(st).b, 615);
});

test('resize: 15-minute steps within limits; a placed card pushes its neighbour', () => {
  let st = day([['a', 30, 600], ['b', 30, 630]]);
  st = J(M.resize(st, 'a', 70)); assert.equal(st.cards[0].len, 75); assert.equal(starts(st).b, 675);
  assert.equal(J(M.resize(st, 'a', 1)).cards[0].len, 15); assert.equal(J(M.resize(st, 'a', 99999)).cards[0].len, 480);
});

test('split: steps become parts, the parent becomes a goal with progress, parts follow each other', () => {
  let st = day([['a', 240, 600], ['z', 30, 840]]); st.cards[0].steps = ['collect', 'outline', 'build']; st.cards[0].cat = null;
  const r = J(M.split(st, 'a')); st = r.state;
  assert.equal(r.ids.length, 3); assert.equal(st.cards.find((c) => c.id === 'a'), undefined);
  const parts = r.ids.map((id) => st.cards.find((c) => c.id === id)); assert.deepEqual(parts.map((p) => p.len), [75, 75, 90], '240 min in 15-minute units: the remainder goes to the last part');
  assert.deepEqual(parts.map((p) => p.s), [600, 675, 750]); assert.deepEqual(parts.map((p) => p.part), ['1/3', '2/3', '3/3']);
  assert.equal(starts(st).z, 840, 'the neighbour after the split keeps its place');
  st = J(M.toggleDone(st, r.ids[0])); const g = M.goalsOverview(st); assert.equal(g.length, 1);
  assert.deepEqual([g[0].t, g[0].n, g[0].done, g[0].minutes], ['a', 3, 1, 240]);
  // too small to split, locked, done: nothing happens
  assert.deepEqual(J(M.split(day([['t', 15, 600]]), 't').ids), []);
  assert.deepEqual(J(M.split(J(M.setLocked(day([['l', 120, 600]]), 'l', true)), 'l').ids), []);
  // a card without steps is split in halves; a part can be split again and stays in the same goal
  const h = J(M.split(day([['h', 120]]), 'h')); assert.deepEqual(h.ids.length, 2); const again = J(M.split(h.state, h.ids[0]));
  assert.equal(again.state.goals.length, 1); assert.equal(M.goalsOverview(again.state)[0].n, 3);
});

test('plan snapshot: free rearranging records nothing, a locked plan shows what moved, was added or taken off', () => {
  let st = day([['a', 30, 600], ['b', 30, 660], ['c', 30, 720]]);
  assert.equal(M.planDiff(st), null);
  st = J(M.lockPlan(st, '09:40')); let d = J(M.planDiff(st)); assert.deepEqual([d.at, d.planned, d.moved, d.added, d.off], ['09:40', 3, 0, 0, 0]);
  st = J(M.place(st, 'a', 645)); st = J(M.moveLoose(st, 'c', 5, 5)); const added = J(M.addCard(st, 'new')); st = J(M.place(added.state, added.id, 780));
  st = J(M.toggleDone(st, 'b')); st = J(M.setTook(st, 'b', 50));
  d = J(M.planDiff(st)); assert.equal(d.moved, 2, 'a and b were pushed or moved'); assert.equal(d.off, 1, 'c went back to the loose cards'); assert.equal(d.added, 1);
  assert.equal(d.done, 1); assert.equal(d.longer, 1); assert.equal(d.ghosts.length, 3);
  assert.equal(J(M.planDiff(J(M.clearPlan(st)))), null);
  // splitting a planned card is not a deviation
  const s2 = J(M.split(J(M.lockPlan(day([['p', 120, 600]]), '08:00')), 'p').state); const d2 = J(M.planDiff(s2)); assert.deepEqual([d2.planned, d2.moved, d2.added, d2.off], [2, 0, 0, 0]);
});

test('load: free time until the day ends, and what crosses the end', () => {
  const st = day([['a', 60, 1290], ['b', 30, 1000], ['c', 30, 800]]); st.wall = 1320;
  // at 15:00: c is already over (counts nothing), b takes 30, a takes the 30 minutes before the end and 30 are over
  assert.deepEqual(J(M.load(st, 900)), { left: 1320 - 900, free: 1320 - 900 - 60, over: 30 });
  assert.deepEqual(J(M.load(J(M.toggleDone(st, 'a')), 900)), { left: 1320 - 900, free: 1320 - 900 - 30, over: 0 }, 'done work counts for nothing');
});

test('rollDay: an old day is archived and replaced by an empty one that keeps categories and the day end', () => {
  const st = day([['a', 30, 600]]); st.wall = 1260; st.cats = [{ id: 'z', name: 'zz', color: '#112233' }];
  const same = M.rollDay(st, '2026-01-05'); assert.equal(same.state, st); assert.equal(same.archived, null);
  const r = J(M.rollDay(st, '2026-01-06')); assert.equal(r.state.day, '2026-01-06'); assert.equal(r.state.cards.length, 0);
  assert.equal(r.state.wall, 1260); assert.deepEqual(r.state.cats, st.cats); assert.equal(r.archived.cards.length, 1);
  assert.equal(M.rollDay(J(M.empty('2026-01-05')), '2026-01-06').archived, null, 'an empty day is not worth archiving');
});

test('categories and quick add: names, colours, loose cards get a free spot', () => {
  let st = J(M.empty('2026-01-05'));
  st = J(M.patchCat(st, 'a', { name: '  garden ', color: '#123456' })); assert.deepEqual([st.cats[0].name, st.cats[0].color], ['garden', '#123456']);
  st = J(M.patchCat(st, 'a', { name: '', color: 'nope' })); assert.deepEqual([st.cats[0].name, st.cats[0].color], ['garden', '#123456'], 'bad input is ignored');
  st = J(M.addCat(st)); assert.equal(st.cats.length, 5); assert.ok(st.cats.at(-1).id);
  const a = J(M.addCard(st, 'one')); const b = J(M.addCard(a.state, 'two'));
  const [p, q] = b.state.cards; assert.ok(p.x !== q.x || p.y !== q.y, 'two new cards do not sit on top of each other'); assert.equal(p.raw, true);
  assert.equal(J(M.setCat(b.state, a.id, 'a')).cards[0].raw, undefined, 'a category makes it a normal card');
});

test('chunks: ASCII only, and joined they parse back to the state', () => {
  let st = J(M.addCard(J(M.empty('2026-01-05')), 'café ☃ ' + 'x'.repeat(5000)).state);
  const parts = M.chunks(st, 100); assert.ok(parts.length > 3); assert.ok(parts.every((p) => /^[\x00-\x7f]*$/.test(p)));
  assert.equal(JSON.parse(parts.join('')).cards[0].t.slice(0, 6), 'café ☃');
});

test('the widget is listed as an example, and load/save keep one file per day in the state dir', async () => {
  const h = await startHatch();
  try {
    assert.ok((await h.call('GET', '/api/examples')).data.some((e) => e.name === 'tide'));
    const open = await h.call('POST', '/api/examples/tide/open', {}); assert.equal(open.status, 200, JSON.stringify(open.data));
    const call = async (source, arg) => (await h.call('POST', '/api/call', { widget: 'tide', source, ...(arg !== undefined && { arg }) })).data.value;
    assert.equal((await call('load')).json, null, 'nothing saved yet');
    const state = J(M.addCard(J(M.empty('2026-01-05')), 'café').state); const parts = M.chunks(state, 40);
    assert.ok(parts.length > 1);
    for (const [i, p] of parts.entries()) assert.deepEqual((await call('save', (i ? 'A ' : 'B ') + p)).json, { ok: true });
    assert.equal(fs.existsSync(path.join(h.stateDir, 'tide', 'today.json')), false, 'nothing is visible before the last step');
    assert.deepEqual((await call('save', 'C')).json, { ok: true });
    assert.deepEqual((await call('load')).json, state);
    // an earlier day goes to the archive; ids that are not a date are refused
    assert.deepEqual((await call('save', 'B:2026-01-04 {"old":true}')).json, { ok: true }); await call('save', 'C:2026-01-04');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.stateDir, 'tide', 'archive', '2026-01-04.json'), 'utf8')), { old: true });
    assert.match((await call('save', 'B:../x {}')).error, /bad day id/);
    // the data lives outside the widget folder: closing the window and removing the widget keeps the day
    assert.equal((await h.call('DELETE', '/api/widgets/tide')).status, 200);
    assert.ok(fs.existsSync(path.join(h.stateDir, 'tide', 'today.json')));
  } finally { await h.close(); }
});
