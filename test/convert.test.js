import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startHatch } from './helpers.js';

test('convert: note <-> progress keeps title and geometry', async () => {
  const h = await startHatch();
  try {
    const n = (await h.call('POST', '/api/panels', { type: 'note', title: 'Plan', x: 77, y: 66, w: 500, h: 250, props: { markdown: '- [x] Build\n- [ ] Ship it\n```\n- [ ] not a step\n```\n' } })).data;
    const r = await h.call('POST', `/api/panels/${n.id}/convert`, { to: 'diagram' });
    assert.equal(r.status, 200);
    assert.equal(r.data.type, 'progress');
    assert.equal(r.data.title, 'Plan');
    assert.deepEqual([r.data.x, r.data.y, r.data.w, r.data.h], [77, 66, 500, 250]);
    assert.equal((await h.call('GET', `/api/panels/${n.id}`)).status, 404);
    const prog = (await h.call('GET', '/api/progress')).data;
    assert.deepEqual(prog.steps.map((s) => [s.title, s.status]), [['Build', 'done'], ['Ship it', 'todo']]);
    const back = (await h.call('POST', '/api/panels/progress/convert', { to: 'note' })).data;
    assert.equal(back.type, 'note');
    assert.equal(back.title, 'Plan');
    assert.match(back.props.markdown, /- \[x\] Build\n- \[ \] Ship it/);
  } finally { await h.close(); }
});

test('convert: note <-> widget round trip', async () => {
  const h = await startHatch();
  try {
    const n = (await h.call('POST', '/api/panels', { type: 'note', title: 'My <Note>', props: { markdown: 'hello <b>x</b>' } })).data;
    const w = (await h.call('POST', `/api/panels/${n.id}/convert`, { to: 'widget' })).data;
    assert.equal(w.type, 'widget');
    const html = fs.readFileSync(path.join(h.stateDir, 'widgets', w.props.name, 'index.html'), 'utf8');
    assert.match(html, /hello &lt;b&gt;x&lt;\/b&gt;/);
    const back = (await h.call('POST', `/api/panels/${w.id}/convert`, { to: 'note' })).data;
    assert.equal(back.props.markdown, 'hello <b>x</b>');
  } finally { await h.close(); }
});

test('convert: unsupported pairs say what is possible', async () => {
  const h = await startHatch();
  try {
    const n = (await h.call('POST', '/api/panels', { type: 'note', props: { markdown: 'no checklist' } })).data;
    let r = await h.call('POST', `/api/panels/${n.id}/convert`, { to: 'image' });
    assert.equal(r.status, 400);
    assert.match(r.data.error || r.data, /note window can become: progress, widget/);
    r = await h.call('POST', `/api/panels/${n.id}/convert`, { to: 'progress' });
    assert.equal(r.status, 400);
    assert.match(r.data.error || r.data, /no checklist items/);
    const g = (await h.call('POST', '/api/panels', { type: 'iframe', props: { url: 'http://localhost:1/' } })).data;
    r = await h.call('POST', `/api/panels/${g.id}/convert`, { to: 'note' });
    assert.match(r.data.error || r.data, /iframe window cannot be converted/);
    assert.equal((await h.call('POST', '/api/panels/nope/convert', { to: 'note' })).status, 404);
  } finally { await h.close(); }
});
