import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHatch, PNG } from './helpers.js';
import { progressSummary } from '../public/panels/progress.js';

const HATCH = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
function cli(h, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HATCH, ...args], { env: { ...process.env, HATCH_STATE: h.stateDir }, cwd: h.dir });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr })); child.stdin.end(input);
  });
}

test('hatch open detects targets, popup opens a built-in, and minimized singletons reopen', async () => {
  const h = await startHatch();
  try {
    fs.writeFileSync(path.join(h.dir, 'picture.png'), PNG);
    fs.writeFileSync(path.join(h.dir, 'notes.txt'), 'notes');
    for (const target of ['picture.png', 'notes.txt', '.', 'https://example.com']) {
      const r = await cli(h, ['open', target]); assert.equal(r.status, 0, r.stderr);
    }
    let panels = (await h.call('GET', '/api/panels')).data;
    assert.deepEqual(panels.map((p) => p.type).sort(), ['editor', 'files', 'iframe', 'image']);
    const missing = await cli(h, ['open', 'missing.txt']); assert.equal(missing.status, 1); assert.match(missing.stderr, /no such file/);
    let r = await cli(h, ['popup', 'open', 'cpu']); assert.equal(r.status, 0, r.stderr);
    r = await cli(h, ['minimize', 'w-cpu']); assert.equal(r.status, 0, r.stderr);
    assert.equal((await h.call('GET', '/api/panels/w-cpu')).data.minimized, true);
    r = await cli(h, ['popup', 'open', 'cpu']); assert.equal(r.status, 0, r.stderr);
    assert.equal(Boolean((await h.call('GET', '/api/panels/w-cpu')).data.minimized), false);
    panels = (await h.call('GET', '/api/panels')).data;
    assert.equal(panels.filter((p) => p.id === 'w-cpu').length, 1);
  } finally { await h.close(); }
});

test('granular progress retains details and groups through updates and disk reload', async () => {
  const h = await startHatch();
  try {
    let r = await cli(h, ['progress', 'plan', 'Inspect', 'Build', 'Verify']); assert.equal(r.status, 0, r.stderr);
    let steps = (await h.call('GET', '/api/progress/steps')).data;
    r = await cli(h, ['progress', 'step', steps[0].id, 'running', '--detail', 'Tracing window focus', '--group', 'Discovery']); assert.equal(r.status, 0, r.stderr);
    await h.call('PATCH', `/api/progress/steps/${steps[0].id}`, { status: 'done' });
    steps = (await h.call('GET', '/api/progress/steps')).data;
    assert.equal(steps[0].detail, 'Tracing window focus'); assert.equal(steps[0].group, 'Discovery'); assert.equal(steps[0].status, 'done');
    const disk = JSON.parse(fs.readFileSync(path.join(h.stateDir, 'progress/steps.json'), 'utf8'));
    assert.equal(disk[0].detail, steps[0].detail);
    assert.equal((await h.call('PATCH', `/api/progress/steps/${steps[0].id}`, { status: 'blocked', detail: {} })).status, 400);
    assert.equal((await h.call('GET', '/api/progress/steps')).data[0].status, 'done');
    r = await cli(h, ['progress', 'open']); assert.equal(r.status, 0, r.stderr);
    await cli(h, ['minimize', 'progress']); await cli(h, ['progress', 'open']);
    const p = (await h.call('GET', '/api/panels/progress')).data;
    assert.equal(p.placement, 'float'); assert.equal(Boolean(p.minimized), false);
  } finally { await h.close(); }
});

test('progress summary prioritizes blockers and counts skipped work as resolved', () => {
  assert.deepEqual(progressSummary([]), { done: 0, skipped: 0, total: 0, current: undefined, percent: 0 });
  const steps = [{status:'done'}, {status:'running',title:'Build'}, {status:'blocked',title:'Access'}, {status:'skipped'}];
  const summary = progressSummary(steps); assert.equal(summary.current.title, 'Access'); assert.equal(summary.percent, 50); assert.equal(summary.done, 1);
});

test('popup window options persist, apply to built-ins, and invalid sizes never create panels', async () => {
  const h = await startHatch();
  try {
    fs.writeFileSync(path.join(h.dir, 'picture.png'), PNG);
    let r = await cli(h, ['image', 'picture.png', '--size', '720x480', '--full', '--no-focus']); assert.equal(r.status, 0, r.stderr);
    let panels = (await h.call('GET', '/api/panels')).data;
    assert.equal(panels[0].w, 720); assert.equal(panels[0].h, 480); assert.equal(panels[0].maximized, true); assert.equal(panels[0].autoFocus, false);
    r = await cli(h, ['popup', 'open', 'clock', '--size', '500x240', '--no-focus']); assert.equal(r.status, 0, r.stderr);
    let clock = (await h.call('GET', '/api/panels/w-clock')).data;
    assert.equal(clock.w, 500); assert.equal(clock.h, 240); assert.equal(clock.autoFocus, false);
    r = await cli(h, ['popup', 'open', 'clock', '--size', '600x300']); assert.equal(r.status, 0, r.stderr);
    clock = (await h.call('GET', '/api/panels/w-clock')).data;
    assert.equal(clock.w, 600); assert.equal(clock.autoFocus, undefined); assert.ok(clock.activation);
    r = await cli(h, ['image', 'picture.png', '--size', 'oops']); assert.equal(r.status, 1); assert.match(r.stderr, /WIDTHxHEIGHT/);
    assert.equal((await h.call('GET', '/api/panels')).data.length, 2);
    const cfgPath = path.join(h.stateDir, 'config.json'); const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, imageSize: '800x550' }));
    r = await cli(h, ['open', 'picture.png']); assert.equal(r.status, 0, r.stderr);
    panels = (await h.call('GET', '/api/panels')).data;
    const image = panels.filter((p) => p.type === 'image').at(-1); assert.equal(image.w, 800); assert.equal(image.h, 550);
  } finally { await h.close(); }
});

test('SVG image display uses a script-free sandbox and rejects disguised non-images', async () => {
  const h=await startHatch();
  try {
    const svg=path.join(h.dir,'drawing.svg');fs.writeFileSync(svg,'<?xml version="1.0"?>\n<!-- a drawing -->\n<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600"><rect width="2400" height="1600" fill="teal"/></svg>');
    let response=await fetch(`${h.base}/api/file?path=${encodeURIComponent(svg)}`,{headers:{'x-token':h.hatch.token}});
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/svg+xml');
    assert.match(response.headers.get('content-security-policy'),/sandbox; default-src 'none'/);
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.match(await response.text(),/<svg/);
    fs.writeFileSync(svg,'<html><script>alert(1)</script></html>');
    response=await fetch(`${h.base}/api/file?path=${encodeURIComponent(svg)}`,{headers:{'x-token':h.hatch.token}});assert.equal(response.status,415);
    const r=await cli(h,['open','drawing.svg']);assert.equal(r.status,0,r.stderr);assert.equal((await h.call('GET','/api/panels')).data[0].type,'image');
  } finally {await h.close();}
});

test('CLI popups open native tools, create widgets, preserve progress geometry and accept global options first', async () => {
  const h=await startHatch();
  try {
    let r=await cli(h,['--state',h.stateDir,'popup','create','quick-clock','--from','clock','--size','520x260']);assert.equal(r.status,0,r.stderr);
    assert.equal((await h.call('GET','/api/panels/w-quick-clock')).data.w,520);
    r=await cli(h,['popup','open','progress']);assert.equal(r.status,0,r.stderr);
    await h.call('PATCH','/api/panels/progress',{w:777,h:444});
    r=await cli(h,['progress','open']);assert.equal(r.status,0,r.stderr);
    assert.equal((await h.call('GET','/api/panels/progress')).data.w,777);
    r=await cli(h,['popup','open','files']);assert.equal(r.status,0,r.stderr);
    r=await cli(h,['popup','open','note','A quick note']);assert.equal(r.status,0,r.stderr);
    r=await cli(h,['--state',h.stateDir,'note','--','--literal-markdown']);assert.equal(r.status,0,r.stderr);
    assert.ok((await h.call('GET','/api/panels')).data.some(p=>p.props.markdown==='--literal-markdown'));
    r=await cli(h,['popup','examples','--json']);assert.equal(r.status,0,r.stderr);assert.ok(JSON.parse(r.stdout).some(p=>p.name==='progress'));
    r=await cli(h,['popup','list','--json']);assert.equal(r.status,0,r.stderr);assert.ok(JSON.parse(r.stdout).some(p=>p.type==='progress'));
    r=await cli(h,['popup','close','progress']);assert.equal(r.status,0,r.stderr);assert.equal((await h.call('GET','/api/panels/progress')).status,404);
    r=await cli(h,['popup','open','nonexistent-widget']);assert.equal(r.status,1);assert.match(r.stderr,/no widget/);
    const before=(await h.call('GET','/api/panels')).data;
    r=await cli(h,['progress','set','-'],'flowchart LR\n a --> b');assert.equal(r.status,0,r.stderr);
    assert.deepEqual((await h.call('GET','/api/panels')).data,before,'data updates do not alter popup focus or geometry');
    r=await cli(h,['progress','--json']);assert.equal(r.status,0,r.stderr);assert.match(JSON.parse(r.stdout).diagram,/a --> b/);
    for(const cmd of ['popup','progress','image','open','agent']) {r=await cli(h,[cmd,'--help']);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,new RegExp(`hatch ${cmd}`));}
  } finally {await h.close();}
});

test('atomic named progress updates keep colliding titles distinct and partial edits retain the latest status', async () => {
  const h=await startHatch();
  try {
    const names=['A+B','A B','你好','再见'];
    const results=await Promise.all(names.map(name=>h.call('POST','/api/progress/steps',{name,status:'todo'})));
    assert.ok(results.every(r=>r.status===200));const ids=results.map(r=>r.data.id);assert.equal(new Set(ids).size,4);
    let r=await h.call('POST','/api/progress/steps',{name:'A B',status:'running',detail:'Live work'});assert.equal(r.status,200);assert.equal(r.data.id,ids[1]);
    r=await h.call('PATCH',`/api/progress/steps/${ids[1]}`,{detail:'Manual context'});assert.equal(r.status,200);
    const steps=(await h.call('GET','/api/progress/steps')).data;assert.equal(steps.length,4);assert.equal(steps.find(s=>s.id===ids[1]).status,'running');assert.equal(steps.find(s=>s.id===ids[1]).detail,'Manual context');
    assert.equal((await h.call('POST','/api/progress/steps',{name:' ',status:'todo'})).status,400);
  } finally {await h.close();}
});

test('conditional note saves preserve newer hand edits and malformed files', async () => {
  const h = await startHatch();
  try {
    const note = (await h.call('POST', '/api/panels', { type: 'note', props: { markdown: 'Original' } })).data;
    const route = `/api/panels/${note.id}`; const file = path.join(h.stateDir, 'panels', `${note.id}.json`);
    let result = await h.call('PATCH', route, { props: { markdown: 'Browser edit' }, ifMarkdown: 'Original' });
    assert.equal(result.status, 200); assert.equal(result.data.props.markdown, 'Browser edit');
    const manual = { ...result.data, title: 'Manual title', props: { markdown: 'Agent edit' } }; fs.writeFileSync(file, JSON.stringify(manual));
    result = await h.call('PATCH', route, { props: { markdown: 'Stale browser draft' }, ifMarkdown: 'Browser edit' });
    assert.equal(result.status, 409); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).props.markdown, 'Agent edit');
    result = await h.call('PATCH', route, { props: { markdown: 'Merged edit' }, ifMarkdown: 'Agent edit' });
    assert.equal(result.status, 200); assert.equal(result.data.title, 'Manual title');
    assert.equal((await h.call('PATCH', route, { props: { markdown: 'Invalid condition' }, ifMarkdown: [] })).status, 400);
    fs.writeFileSync(file, '{broken');
    assert.equal((await h.call('PATCH', route, { props: { markdown: 'Do not overwrite' }, ifMarkdown: 'Merged edit' })).status, 409);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
    fs.unlinkSync(file);
    assert.equal((await h.call('PATCH', route, { props: { markdown: 'Do not recreate' }, ifMarkdown: 'Merged edit' })).status, 404);
    assert.ok(!fs.existsSync(file));
  } finally { await h.close(); }
});

test('per-window opacity is stored clamped, survives patches, and 100 is stored as opaque', async () => {
  const h = await startHatch();
  try {
    fs.writeFileSync(path.join(h.dir, 'picture.png'), PNG);
    await cli(h, ['image', 'picture.png']);
    const id = (await h.call('GET', '/api/panels')).data[0].id;
    for (const [sent, want] of [[70, 70], [5, 20], [55.4, 55]]) {
      await h.call('PATCH', `/api/panels/${id}`, { opacity: sent });
      assert.equal((await h.call('GET', `/api/panels/${id}`)).data.opacity, want);
    }
    await h.call('PATCH', `/api/panels/${id}`, { x: 90 });
    assert.equal((await h.call('GET', `/api/panels/${id}`)).data.opacity, 55, 'other patches keep it');
    await h.call('PATCH', `/api/panels/${id}`, { opacity: 100 });
    assert.equal((await h.call('GET', `/api/panels/${id}`)).data.opacity, 100);
  } finally { await h.close(); }
});
