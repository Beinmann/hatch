import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHatch, tmp, PNG, waitFor } from './helpers.js';
import { findWidgetPanel, createScreenshots } from '../src/screenshots.js';

const CLI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
const SHOT = fileURLToPath(new URL('../public/shot.js', import.meta.url));
const FAKE_HOME = tmp();
const cli = (args, { state, cwd } = {}) => new Promise((resolve) => {
  const p = spawn('node', [CLI, ...(state ? ['--state', state] : []), ...args], { cwd, env: { ...process.env, HOME: FAKE_HOME, HATCH_STATE: '', HATCH_WORKSPACE: '' } });
  let stdout = ''; let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => resolve({ status, stdout, stderr }));
  p.stdin.end();
});
// the renderer is a classic browser script; its pure part runs here with a stub window
const shot = (() => { const ctx = { window: {} }; vm.runInNewContext(fs.readFileSync(SHOT, 'utf8'), ctx); return ctx.window.hatchShot; })();

test('abstractHtml: text becomes grey bars, structure and non-text stay', () => {
  const out = shot.abstractHtml('<html><head><title>Secret</title><style>.a{color:red}</style></head><body><div class="a" title="t">Hello <b>big</b> world</div>\n  <p>  padded  </p><svg><text>label</text><foreignObject><span>in fo</span></foreignObject></svg><textarea></textarea></body></html>');
  assert.match(out, /<div class="a" title="t"><span class="hx-abs">Hello<\/span> <b><span class="hx-abs">big<\/span><\/b> <span class="hx-abs">world<\/span><\/div>/);
  assert.match(out, /<p>  <span class="hx-abs">padded<\/span>  <\/p>/);
  assert.match(out, /<title>Secret<\/title>/, 'title and style text are not wrapped');
  assert.match(out, /<style>\.a\{color:red\}<\/style>/);
  assert.match(out, /<text>label<\/text>/, 'plain svg text is hidden by the stylesheet instead');
  assert.match(out, /<foreignObject><span><span class="hx-abs">in fo<\/span><\/span><\/foreignObject>/);
  assert.equal((out.match(/class="hx-abs"/g) || []).length, 5);
  assert.equal(shot.abstractHtml('<p/>'), '<p/>'); assert.equal(shot.abstractHtml(''), '');
  // nothing readable is left: removing the bar markup and tags leaves only the allowed raw text
  const visible = out.replace(/<style>[\s\S]*?<\/style>|<title>[\s\S]*?<\/title>|<text>[\s\S]*?<\/text>|<span class="hx-abs">[^<]*<\/span>/g, '').replace(/<[^>]*>/g, '').trim();
  assert.equal(visible, '');
  assert.match(shot.ABSTRACT_CSS, /\.hx-abs\{color:transparent/);
});

test('findWidgetPanel: id, widget name, board file name, title; workspace and ambiguity', () => {
  const panels = [
    { id: 'w-board-plan', type: 'widget', title: 'Board: plan', props: { name: 'board-plan' }, ws: 'main' },
    { id: 'w-clock', type: 'widget', title: 'Clock', props: { name: 'clock' } },
    { id: 'p1', type: 'note', title: 'plan', props: {} },
    { id: 'w-board-plan-2', type: 'widget', title: 'Board: plan', props: { name: 'board-plan' }, ws: 'other' },
  ];
  assert.equal(findWidgetPanel(panels, 'w-clock').id, 'w-clock');
  assert.equal(findWidgetPanel(panels, 'clock').id, 'w-clock');
  assert.equal(findWidgetPanel(panels, './docs/plan.board.json').id, 'w-board-plan', 'a board file name maps to its widget; main wins');
  assert.equal(findWidgetPanel(panels, 'plan', 'other').id, 'w-board-plan-2');
  assert.equal(findWidgetPanel(panels, 'board: PLAN').id, 'w-board-plan');
  assert.throws(() => findWidgetPanel(panels, 'nope'), (e) => e.status === 404 && /open it first/.test(e.message));
  assert.throws(() => findWidgetPanel(panels, ''), (e) => e.status === 400);
  assert.throws(() => findWidgetPanel(panels, 'plan', 'third').id, (e) => e.status === 409 && /more than one/.test(e.message));
  assert.throws(() => findWidgetPanel(panels, 'p1'), (e) => e.status === 404, 'a note is not a widget');
});

test('screenshots: one tab gets the request, errors and timeouts reject', async () => {
  const sent = [];
  const s = createScreenshots({ emit: (e, d, pick) => { const ok = pick({ cid: 'a' }); if (ok) sent.push([e, d]); return ok ? 1 : 0; }, timeoutMs: 80 });
  await assert.rejects(s.request({ panel: 'x' }, () => false), (e) => e.status === 409 && /no Hatch browser tab/.test(e.message));
  const p = s.request({ panel: 'x', abstract: true }, () => true);
  assert.equal(sent[0][0], 'screenshot'); assert.deepEqual([sent[0][1].panel, sent[0][1].abstract, sent[0][1].scale], ['x', true, 2]);
  s.answer(sent[0][1].id, { png: 'AAAA', width: 3, height: 4 });
  assert.deepEqual(await p, { png: 'AAAA', width: 3, height: 4 });
  assert.throws(() => s.answer(sent[0][1].id, { png: 'AAAA' }), (e) => e.status === 404);
  const bad = s.request({ panel: 'x' }, () => true); s.answer(sent[1][1].id, { error: 'boom' });
  await assert.rejects(bad, /could not render it: boom/);
  await assert.rejects(s.request({ panel: 'x' }, () => true), (e) => e.status === 504);
  assert.equal(s.pending(), 0);
});

test('hatch widget screenshot: usage errors, no tab, and a full relay to a fake tab', async () => {
  const h = await startHatch(); const s = h.stateDir;
  try {
    let r = await cli(['widget', 'screenshot'], { state: s }); assert.equal(r.status, 1); assert.match(r.stderr, /usage: widget screenshot/);
    r = await cli(['widget', 'screenshot', 'plan', '--scale', '9'], { state: s }); assert.equal(r.status, 1); assert.match(r.stderr, /--scale/);
    r = await cli(['widget', 'screenshot', 'plan'], { state: s }); assert.equal(r.status, 1); assert.match(r.stderr, /no open widget or board window/);

    const made = await h.call('POST', '/api/panels', { type: 'widget', title: 'Board: plan', props: { name: 'board-plan' } });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    r = await cli(['widget', 'screenshot', 'plan'], { state: s }); assert.equal(r.status, 1); assert.match(r.stderr, /no Hatch browser tab is open/);

    // a fake browser tab: an event stream that answers screenshot events
    const ctl = new AbortController(); const got = [];
    const res = await fetch(`${h.base}/api/events?cid=fake`, { headers: { 'x-token': h.hatch.token }, signal: ctl.signal });
    (async () => {
      let buf = ''; const dec = new TextDecoder();
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true }); let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            if (!/^event: screenshot$/m.test(block)) continue;
            const d = JSON.parse(/^data: (.*)$/m.exec(block)[1]); got.push(d);
            await h.call('POST', `/api/screenshot/${d.id}`, { png: PNG.toString('base64'), width: 640, height: 480 });
          }
        }
      } catch { /* aborted */ }
    })();
    try {
      const out = path.join(h.dir, 'shots', 'b.png'); fs.mkdirSync(path.dirname(out));
      r = await cli(['widget', 'screenshot', 'plan', '--out', out, '--abstract', '--scale', '1'], { state: s });
      assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /b\.png \(640x480 CSS px, 1x, abstract\)/);
      assert.deepEqual(fs.readFileSync(out), PNG);
      assert.deepEqual([got[0].panel, got[0].abstract, got[0].scale], [made.data.id, true, 1]);
      // default file name in the current directory
      r = await cli(['widget', 'screenshot', 'board-plan'], { state: s, cwd: h.dir }); assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(fs.readFileSync(path.join(h.dir, 'board-plan.png')), PNG); assert.equal(got[1].abstract, false);
      // the tab reports a render failure
      await waitFor(() => got.length === 2);
    } finally { ctl.abort(); }
    const bad = await h.call('POST', '/api/screenshot/sdeadbeef', { png: 'x' }); assert.equal(bad.status, 404);
    const sc = await h.call('POST', '/api/screenshot', { name: 'plan', scale: 'x' }); assert.equal(sc.status, 400);
  } finally { await h.close(); }
});
