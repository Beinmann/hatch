import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createState, checkPanel, applyStepClass, layout } from '../src/state.js';
import { tmp, waitFor } from './helpers.js';

test('checkPanel validates types and props', () => {
  assert.ok(checkPanel({ type: 'note', props: { markdown: 'x' } }, 'p1').panel);
  assert.match(checkPanel({ type: 'nope' }, 'p1').error, /type must be/);
  assert.match(checkPanel({ type: 'image', props: {} }, 'p1').error, /props\.src/);
  assert.match(checkPanel({ type: 'widget', props: { name: '../x' } }, 'p1').error, /props\.name/);
  assert.equal(checkPanel({ type: 'note', props: { markdown: '' }, placement: 'dock', x: 3.6 }, 'p1').panel.x, 4);
});

test('hand-edited panel files are picked up; bad JSON warns and keeps the last good panel', async () => {
  const dir = tmp(); const events = [];
  const st = createState(dir, { emit: (e, d) => events.push([e, d]), poll: true });
  st.start();
  const l = layout(dir);
  fs.writeFileSync(path.join(l.panels, 'p1.json'), JSON.stringify({ type: 'note', props: { markdown: 'hi' } }));
  st.rescan();
  assert.equal(st.listPanels().length, 1);
  fs.writeFileSync(path.join(l.panels, 'p1.json'), '{ nope');
  st.rescan();
  assert.equal(st.listPanels().length, 1, 'last good panel stays');
  assert.ok(events.some(([e, d]) => e === 'warning' && /invalid JSON/.test(d.message)));
  fs.writeFileSync(path.join(l.panels, 'p1.json'), JSON.stringify({ type: 'note', props: { markdown: 'fixed' } }));
  st.rescan();
  assert.equal(st.getPanel('p1').props.markdown, 'fixed');
  assert.ok(events.some(([e, d]) => e === 'warning' && d.message === null), 'warning cleared');
  fs.rmSync(path.join(l.panels, 'p1.json')); st.rescan();
  assert.equal(st.listPanels().length, 0);
  st.close();
});

test('progress: history is kept (capped) and step status rewrites the class line', () => {
  const dir = tmp(); const st = createState(dir, { poll: true }); st.start();
  st.setDiagram('flowchart LR\n  a --> b\n');
  st.setDiagram('flowchart LR\n  a --> b --> c\n');
  assert.equal(fs.readdirSync(layout(dir).history).length, 1);
  st.patchStep('a', { status: 'running', title: 'A' });
  assert.match(st.getProgress().diagram, /class a running/);
  st.patchStep('a', { status: 'done' });
  const d = st.getProgress().diagram;
  assert.match(d, /class a done/); assert.doesNotMatch(d, /class a running/);
  assert.equal(st.getProgress().steps[0].status, 'done');
  assert.throws(() => st.patchStep('a', { status: 'wat' }), /status must be/);
  for (let i = 0; i < 60; i++) st.setDiagram(`flowchart LR\n  x${i} --> y\n`);
  assert.ok(fs.readdirSync(layout(dir).history).length <= 50);
  st.close();
});

test('applyStepClass leaves non-flowcharts and unknown ids alone', () => {
  assert.equal(applyStepClass('sequenceDiagram\n a->>b: x\n', 'a', 'done'), 'sequenceDiagram\n a->>b: x\n');
  assert.equal(applyStepClass('flowchart LR\n a --> b\n', 'zzz', 'done'), 'flowchart LR\n a --> b\n');
  assert.equal(applyStepClass('flowchart LR\n a --> b\n', 'write tests', 'done'), 'flowchart LR\n a --> b\n');
});

test('widget revisions bump when a widget file changes', async () => {
  const dir = tmp(); const events = [];
  const st = createState(dir, { emit: (e, d) => events.push([e, d]), poll: true }); st.start();
  const w = path.join(layout(dir).widgets, 'cpu'); fs.mkdirSync(w);
  fs.writeFileSync(path.join(w, 'index.html'), '<p>1</p>'); st.rescan();
  const first = events.filter(([e]) => e === 'widget').length;
  fs.writeFileSync(path.join(w, 'index.html'), '<p>22</p>'); st.rescan();
  assert.equal(events.filter(([e]) => e === 'widget').length, first + 1);
  await waitFor(() => true); st.close();
});

test('a widget\'s top-level data/ folder does not reload it, any other subfolder does', () => {
  const dir = tmp(); const events = [];
  const st = createState(dir, { emit: (e, d) => events.push([e, d]), poll: true }); st.start();
  const w = path.join(layout(dir).widgets, 'saver'); fs.mkdirSync(path.join(w, 'data', 'nested'), { recursive: true }); fs.mkdirSync(path.join(w, 'lib'));
  fs.writeFileSync(path.join(w, 'index.html'), '<p>1</p>'); st.rescan();
  const count = () => events.filter(([e]) => e === 'widget').length; const base = count();
  fs.writeFileSync(path.join(w, 'data', 'a.jpg'), 'x'); fs.writeFileSync(path.join(w, 'data', 'nested', 'b.json'), '{}'); st.rescan();
  assert.equal(count(), base, 'files written into data/ (even nested) are not a widget change');
  fs.writeFileSync(path.join(w, 'lib', 'helper.js'), 'x'); st.rescan();
  assert.equal(count(), base + 1, 'other folders still reload the widget');
  st.close();
});

test('workspace field: stored only when not main, validated, patchable', () => {
  assert.equal(checkPanel({ type: 'note', props: { markdown: 'x' }, ws: 'two' }, 'p1').panel.ws, 'two');
  assert.equal(checkPanel({ type: 'note', props: { markdown: 'x' }, ws: 'main' }, 'p1').panel.ws, undefined);
  assert.equal(checkPanel({ type: 'note', props: { markdown: 'x' }, ws: '../x' }, 'p1').panel.ws, undefined);
  const dir = tmp(); const st = createState(dir, { poll: true }); st.start();
  const p = st.createPanel({ type: 'note', props: { markdown: 'x' } });
  assert.equal(st.patchPanel(p.id, { ws: 'two' }).ws, 'two'); assert.equal(st.patchPanel(p.id, { ws: 'main' }).ws, undefined);
  st.close();
});

test('sticky flag is stored only when true and patchable', () => {
  assert.equal(checkPanel({ type: 'note', props: { markdown: 'x' }, sticky: true }, 'p1').panel.sticky, true);
  assert.equal(checkPanel({ type: 'note', props: { markdown: 'x' }, sticky: 'yes' }, 'p1').panel.sticky, undefined);
  const dir = tmp(); const st = createState(dir, { poll: true }); st.start(); const p = st.createPanel({ type: 'note', props: { markdown: 'x' } });
  assert.equal(st.patchPanel(p.id, { sticky: true }).sticky, true); assert.equal(st.patchPanel(p.id, { sticky: false }).sticky, undefined); st.close();
});

test('progress validation keeps the last good plan, preserves malformed files and picks up direct edits before patches', () => {
  const dir=tmp();const st=createState(dir,{poll:true});st.start();const file=layout(dir).steps;
  try {
    st.setSteps([{id:'a',title:'Inspect',status:'running',detail:'Original detail'}]);
    const good=fs.readFileSync(file,'utf8');
    for(const bad of [[{}],[null],[{id:'a',title:'A'},{id:'a',title:'B'}],[{id:'a',title:'A',detail:{}}],[{id:'a',title:'A',updated:'not a date'}],[{id:'a',title:'A',status:null}]]) {
      assert.throws(()=>st.setSteps(bad));assert.equal(fs.readFileSync(file,'utf8'),good);
    }
    fs.writeFileSync(file,'[{"id":"a","title":"Broken","status":"unknown"}]');st.rescan();
    assert.equal(st.getProgress().steps[0].title,'Inspect');assert.ok(st.snapshot().warnings.some(w=>w.file==='progress/steps.json'));
    assert.throws(()=>st.patchStep('a',{status:'done'}),e=>e.status===409);assert.match(fs.readFileSync(file,'utf8'),/unknown/);
    fs.writeFileSync(file,JSON.stringify([{id:'a',title:'Inspect',status:'done'},{id:'b',title:'Build',status:'running'}]));
    st.patchStep('b',{detail:'Manual context'});assert.equal(st.getProgress().steps.length,2);assert.equal(st.getProgress().steps[0].status,'done');assert.equal(st.getProgress().steps[1].status,'running');
    for (const body of [null, [], 'done', 42]) {
      assert.throws(()=>st.patchStep('b',body),e=>e.status===400);
      assert.throws(()=>st.updateStep('b',body),e=>e.status===400);
    }
    assert.throws(()=>st.patchStep('b',{status:null}));assert.throws(()=>st.patchStep('b',{title:''}));
    fs.rmSync(file);st.rescan();assert.deepEqual(st.getProgress().steps,[]);assert.ok(!st.snapshot().warnings.some(w=>w.file==='progress/steps.json'));
  } finally {st.close();}
});

test('closing a window moves it to the trash; restore, bounds, empty and malformed files', () => {
  const dir = tmp();
  const st = createState(dir, { emit: () => {}, poll: true });
  st.start();
  const l = layout(dir);
  const a = st.createPanel({ type: 'note', title: 'A', props: { markdown: 'a' }, x: 100, y: 120 });
  const t = st.createPanel({ type: 'terminal', title: 'term', props: { name: 'sh2', cmd: 'top' } });
  st.deletePanel(a.id); st.deletePanel(t.id);
  assert.equal(st.listPanels().length, 0);
  assert.equal(fs.readdirSync(l.trash).length, 2);
  const list = st.listTrash();
  assert.equal(list.length, 2);
  assert.equal(list[0].type, 'terminal', 'newest first');
  for (const e of list) assert.match(e.trashId, /^[0-9a-f]{6,8}$/, 'short id');
  assert.notEqual(list[0].trashId, list[1].trashId);
  assert.deepEqual(st.listTrash().map((e) => e.trashId), list.map((e) => e.trashId), 'ids are stable between listings');
  assert.throws(() => st.restoreTrash('nope42'), (e) => e.status === 404 && /no closed window nope42/.test(e.message));
  const oldId = fs.readdirSync(l.trash).find((n) => n.endsWith(`-${a.id}.json`)).slice(0, -5);
  const back = st.restoreTrash(list.find((e) => e.type === 'terminal').trashId); // by short id
  assert.equal(back.type, 'terminal'); assert.equal(back.props.cmd, 'top');
  const noteBack = st.restoreTrash(oldId); // the old full id still works
  assert.equal(noteBack.id, a.id);
  assert.equal(noteBack.x, 100); assert.equal(noteBack.y, 120); assert.equal(noteBack.props.markdown, 'a');
  assert.equal(fs.readdirSync(l.trash).length, 0);
  assert.throws(() => st.restoreTrash(), /trash is empty/);
  // bounded by count, tolerant of junk
  for (let i = 0; i < 35; i++) { const p = st.createPanel({ type: 'note', props: { markdown: String(i) } }); st.deletePanel(p.id); }
  assert.ok(st.listTrash().length <= 30);
  fs.writeFileSync(path.join(l.trash, 'junk.json'), '{ nope');
  assert.ok(st.listTrash().length <= 30, 'malformed entry skipped');
  assert.ok(st.snapshot().warnings.some((w) => w.file === 'trash/junk.json'));
  assert.ok(st.emptyTrash() > 0);
  assert.equal(st.listTrash().length, 0);
  st.close();
});

test('restore by a 3+ char id prefix: unique restores, ambiguous and too short do not', () => {
  const dir = tmp();
  const st = createState(dir, { emit: () => {}, poll: true });
  st.start();
  const l = layout(dir);
  const p = st.createPanel({ type: 'note', title: 'P', props: { markdown: 'p' } });
  st.deletePanel(p.id);
  const src = path.join(l.trash, fs.readdirSync(l.trash)[0]);
  const body = fs.readFileSync(src, 'utf8');
  // Craft entries until two short ids share their first 3 chars (hash of the file name, so search by name).
  const hash = (n) => crypto.createHash('sha1').update(n).digest('hex');
  const stamp = new Date(Date.now() - 60000).toISOString().replace(/[:.]/g, '-'); // recent, or pruning would drop them
  const seen = new Map(); let pair = null;
  for (let i = 0; !pair; i++) {
    const n = `${stamp}-n${i}.json`;
    const k = hash(n).slice(0, 3);
    if (seen.has(k)) pair = [seen.get(k), n]; else seen.set(k, n);
  }
  fs.rmSync(src);
  for (const n of pair) fs.writeFileSync(path.join(l.trash, n), body);
  const lone = `${stamp}-lone.json`;
  fs.writeFileSync(path.join(l.trash, lone), body);
  const ids = st.listTrash().map((e) => e.trashId);
  const shared = hash(pair[0]).slice(0, 3);
  const ambiguous = ids.filter((i) => i.startsWith(shared));
  assert.equal(ambiguous.length, 2);
  assert.throws(() => st.restoreTrash(shared), (e) => e.status === 400 && /matches 2/.test(e.message) && ambiguous.every((i) => e.message.includes(i)));
  assert.equal(st.listTrash().length, 3, 'nothing restored on ambiguity');
  assert.throws(() => st.restoreTrash(ids.find((i) => !i.startsWith(shared)).slice(0, 2)), (e) => e.status === 404, 'two chars is not a prefix');
  assert.throws(() => st.restoreTrash('zzz'), (e) => e.status === 404 && /no closed window zzz/.test(e.message));
  const loneId = st.listTrash().find((e) => !e.trashId.startsWith(shared)).trashId;
  assert.equal(st.restoreTrash(loneId.slice(0, 3)).type, 'note', 'unique prefix restores');
  assert.equal(st.listTrash().length, 2);
  st.close();
});
