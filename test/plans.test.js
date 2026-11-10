import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHatch } from './helpers.js';

const UI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
const ui = (args, { state, env } = {}) => new Promise((resolve) => {
  const p = spawn('node', [UI, '--state', state, ...args], { env: { ...process.env, HATCH_STATE: '', HATCH_PLAN: '', ...env } });
  let stdout = ''; let stderr = ''; p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => resolve({ status, stdout, stderr }));
});

test('plans: no name works as before; a name creates a plan with its own window; two plans without a name is refused', async () => {
  const h = await startHatch();
  try {
    // 0 plans, no name: the classic single plan
    assert.equal((await h.call('PUT', '/api/progress/steps', [{ title: 'one' }])).status, 200);
    assert.deepEqual((await h.call('GET', '/api/progress')).data.steps.map((s) => s.title), ['one']);
    assert.equal((await h.call('GET', '/api/panels')).data.length, 0, 'the unnamed plan opens no window by itself, as before');
    // a named plan is created on first use, with a window titled by its name, and its own file
    assert.equal((await h.call('PUT', '/api/progress/steps?plan=alpha', [{ title: 'a1' }, { title: 'a2', status: 'running' }])).status, 200);
    const panels = (await h.call('GET', '/api/panels')).data; assert.equal(panels.length, 1);
    assert.deepEqual([panels[0].id, panels[0].title, panels[0].props.plan, panels[0].autoFocus], ['progress-alpha', 'alpha', 'alpha', false]);
    const file = path.join(h.stateDir, 'progress', 'plans', 'alpha.json');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).steps.length, 2, 'readable file next to the classic one');
    assert.ok(fs.existsSync(path.join(h.stateDir, 'progress', 'steps.json')), 'the classic file is untouched');
    // two plans and no name: refuse with the names and the way out; with a name it works; "default" names the unnamed one
    for (const [m, route, body] of [['GET', '/api/progress'], ['PUT', '/api/progress/steps', []], ['POST', '/api/progress/steps', { name: 'x', status: 'done' }], ['PUT', '/api/progress/diagram', 'graph TD']]) {
      const r = await h.call(m, route, body); assert.equal(r.status, 409, route); assert.match(r.data.error, /default, alpha/); assert.match(r.data.error, /--plan NAME/); assert.match(r.data.error, /HATCH_PLAN=NAME/);
    }
    assert.equal((await h.call('GET', '/api/progress?plan=default')).data.steps[0].title, 'one');
    assert.equal((await h.call('POST', '/api/progress/steps?plan=alpha', { name: 'a1', status: 'done' })).data.status, 'done');
    assert.equal((await h.call('PATCH', '/api/progress/steps/a2?plan=alpha', { status: 'done' })).status, 200);
    assert.deepEqual((await h.call('GET', '/api/progress?plan=alpha')).data.steps.map((s) => s.status), ['done', 'done']);
    assert.equal((await h.call('GET', '/api/progress?plan=default')).data.steps[0].status, 'todo', 'plans do not leak into each other');
    assert.equal((await h.call('GET', '/api/progress?plan=bad name')).status, 400);
    // listing, then closing removes file and window and leaves one plan again (no name needed)
    assert.deepEqual((await h.call('GET', '/api/progress/plans')).data, [{ name: 'default', steps: 1, done: 0 }, { name: 'alpha', steps: 2, done: 2 }]);
    assert.equal((await h.call('DELETE', '/api/progress/plans/alpha')).status, 200);
    assert.equal(fs.existsSync(file), false); assert.equal((await h.call('GET', '/api/panels')).data.length, 0);
    assert.equal((await h.call('GET', '/api/progress')).data.steps[0].title, 'one');
    assert.equal((await h.call('DELETE', '/api/progress/plans/alpha')).status, 404);
  } finally { await h.close(); }
});

test('plans: only named plans exist, the lone one is used without a name; hand edits load, malformed files warn and keep the last good plan', async () => {
  const h = await startHatch();
  try {
    await h.call('PUT', '/api/progress/steps?plan=solo', [{ title: 's1' }]);
    assert.equal((await h.call('GET', '/api/progress')).data.steps[0].title, 's1', 'one plan: no name needed');
    const dir = path.join(h.stateDir, 'progress', 'plans');
    fs.writeFileSync(path.join(dir, 'hand.json'), JSON.stringify({ steps: [{ id: 'x', title: 'by hand', status: 'done' }], diagram: 'flowchart LR\n  x' }));
    h.hatch.state.rescan();
    const p = (await h.call('GET', '/api/progress?plan=hand')).data; assert.equal(p.steps[0].title, 'by hand'); assert.match(p.diagram, /flowchart/);
    fs.writeFileSync(path.join(dir, 'hand.json'), '{oops'); h.hatch.state.rescan();
    assert.equal((await h.call('GET', '/api/progress?plan=hand')).data.steps[0].title, 'by hand', 'last good plan kept');
    const snap = h.hatch.state.snapshot(); assert.ok(snap.warnings.some((w) => w.file === 'progress/plans/hand.json'));
    assert.deepEqual(Object.keys(snap.plans).sort(), ['hand', 'solo']);
    fs.writeFileSync(path.join(dir, 'bad name.json'), '{}'); fs.writeFileSync(path.join(dir, 'default.json'), '{}'); h.hatch.state.rescan();
    assert.ok(h.hatch.state.snapshot().warnings.some((w) => w.file === 'progress/plans/default.json'), 'default is reserved');
  } finally { await h.close(); }
});

test('plans: the CLI honours --plan and HATCH_PLAN, lists and closes plans, and explains the ambiguity', async () => {
  const h = await startHatch(); const state = h.stateDir;
  try {
    assert.equal((await ui(['progress', 'plan', 'x', 'y'], { state })).status, 0);
    let r = await ui(['progress', 'plan', 'p', 'q', '--plan', 'bee'], { state }); assert.equal(r.status, 0, r.stderr);
    r = await ui(['progress', 'step', 'x', 'done'], { state }); assert.equal(r.status, 1); assert.match(r.stderr, /default, bee/); assert.match(r.stderr, /--plan NAME/);
    r = await ui(['progress', 'step', 'p', 'done'], { state, env: { HATCH_PLAN: 'bee' } }); assert.equal(r.status, 0, r.stderr);
    r = await ui(['progress', 'show', '--json', '--plan', 'bee'], { state }); assert.equal(JSON.parse(r.stdout).steps[0].status, 'done');
    r = await ui(['progress', 'plans'], { state }); assert.match(r.stdout, /default  0\/2 done/); assert.match(r.stdout, /bee  1\/2 done/);
    r = await ui(['progress', 'show', '--plan', 'bad name'], { state }); assert.equal(r.status, 1); assert.match(r.stderr, /not valid/);
    r = await ui(['progress', 'close', '--plan', 'bee'], { state }); assert.equal(r.status, 0, r.stderr);
    r = await ui(['progress', 'plans', '--json'], { state }); assert.deepEqual(JSON.parse(r.stdout).map((x) => x.name), ['default']);
    r = await ui(['progress', 'step', 'x', 'done'], { state }); assert.equal(r.status, 0, 'one plan left: no name needed');
  } finally { await h.close(); }
});
