import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { start, stop, restart, runningPid, mergeOptions } from '../src/daemon.js';
import { findServerStateDir, isValidStateDir } from '../src/find.js';
import { tmp } from './helpers.js';

const EXE = fileURLToPath(new URL('../bin/hatch-server.js', import.meta.url));
test('server state is ./.hatch of the cwd only: parent projects are ignored, --state and HATCH_STATE choose explicitly', () => {
  const project = tmp(); const state = path.join(project, '.hatch'); fs.mkdirSync(state); fs.writeFileSync(path.join(state, 'config.json'), '{}');
  const sub = path.join(project, 'src', 'nested'); fs.mkdirSync(sub, {recursive:true});
  assert.equal(findServerStateDir({cwd:project,env:{}}), state);
  assert.equal(findServerStateDir({cwd:sub,env:{}}), path.join(sub,'.hatch'), 'the parent .hatch is not used');
  assert.equal(findServerStateDir({cwd:sub,env:{HATCH_STATE:state}}), state);
  assert.equal(findServerStateDir({cwd:sub,env:{HATCH_STATE:state},state:'other'}), path.join(sub,'other'));
});
test('a state dir is valid only with a config.json holding port and token', () => {
  const d = tmp(); assert.equal(isValidStateDir(d), false);
  fs.writeFileSync(path.join(d, 'config.json'), '{}'); assert.equal(isValidStateDir(d), false);
  fs.writeFileSync(path.join(d, 'config.json'), '{"port":7070,"token":"abc"}'); assert.equal(isValidStateDir(d), true);
});
function serveIn(cwd, args, { input, env = {} } = {}) {
  return spawnSync(process.execPath, [EXE, 'serve', '--port', '0', '--host', '127.0.0.1', ...args], { cwd, input, encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL', env: { ...process.env, HATCH_STATE: '', ...env } });
}
test('serve without a terminal and without --yes creates nothing and names --yes and --state', () => {
  const d = tmp(); const r = serveIn(d, []);
  assert.equal(r.status, 1); assert.match(r.stderr, /--yes/); assert.match(r.stderr, /--state DIR/); assert.ok(r.stderr.includes(path.join(d, '.hatch')));
  assert.equal(fs.existsSync(path.join(d, '.hatch')), false);
  const parent = tmp(); fs.mkdirSync(path.join(parent, '.hatch')); fs.writeFileSync(path.join(parent, '.hatch', 'config.json'), '{"port":7070,"token":"abc"}');
  const sub = path.join(parent, 'sub'); fs.mkdirSync(sub);
  assert.equal(serveIn(sub, []).status, 1, 'a valid parent state does not count'); assert.equal(fs.existsSync(path.join(sub, '.hatch')), false);
  const e = serveIn(d, ['--state', path.join(d, 'explicit')]); assert.equal(e.status, 1); assert.equal(fs.existsSync(path.join(d, 'explicit')), false);
});
test('serve --yes creates ./.hatch, --state DIR with --yes creates that dir; an existing valid dir needs no confirmation', () => {
  const run = (cwd, args) => { // the server keeps running: let it print its line, then kill it
    const r = spawnSync(process.execPath, [EXE, 'serve', '--port', '0', '--host', '127.0.0.1', ...args], { cwd, encoding: 'utf8', timeout: 2500, killSignal: 'SIGKILL', env: { ...process.env, HATCH_STATE: '' } });
    return r;
  };
  const d = tmp(); run(d, ['--yes']); assert.ok(isValidStateDir(path.join(d, '.hatch')), './.hatch created with --yes');
  const x = tmp(); const target = path.join(x, 'elsewhere'); run(x, ['--state', target, '--yes']); assert.ok(isValidStateDir(target));
  const again = run(d, []); assert.doesNotMatch(again.stderr, /--yes/, 'valid dir: no confirmation needed');
});
test('serve asks on a terminal: no declines with a non-zero code and creates nothing, yes creates', { skip: spawnSync('script', ['--version']).status !== 0 }, () => {
  const d = tmp();
  const ask = (answer) => spawnSync('script', ['-qec', `node ${EXE} serve --port 0 --host 127.0.0.1`, '/dev/null'], { cwd: d, input: `${answer}\n`, encoding: 'utf8', timeout: 2500, killSignal: 'SIGKILL', env: { ...process.env, HATCH_STATE: '' } });
  const no = ask('n'); assert.match(no.stdout, /Create it\? \[y\/N\]/); assert.ok(no.stdout.includes(path.join(d, '.hatch'))); assert.equal(fs.existsSync(path.join(d, '.hatch')), false);
  ask('y'); assert.ok(isValidStateDir(path.join(d, '.hatch')));
});
test('startup overrides retain unrelated saved options and handle equals flags', () => {
  assert.deepEqual(mergeOptions(['--root','/srv/project','--port','7070','--view-only'],['--port=7080','--view-only=false']),['--root','/srv/project','--port=7080','--view-only=false']);
  assert.deepEqual(mergeOptions(['--host=127.0.0.1','--tmux-status'],[]),['--host=127.0.0.1','--tmux-status']);
});
test('concurrent starts share one daemon; restart retains root, cwd and host; stale PID cannot stop another project', async () => {
  const dir=tmp();const state=path.join(dir,'.hatch');let first;
  try {
    const starts=await Promise.all([start(state,EXE,['--host','127.0.0.1','--port','0','--root',dir,'--cwd',dir]),start(state,EXE)]);
    assert.equal(starts[0].pid,starts[1].pid);assert.equal(starts.filter(r=>r.already).length,1);first=starts[0].pid;
    assert.equal(runningPid(state),first);
    const other=path.join(tmp(),'.hatch');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'hatch.pid'),String(first));
    assert.equal(runningPid(other),null);assert.equal(await stop(other),false);assert.equal(runningPid(state),first);
    const again=await restart(state,EXE);assert.notEqual(again.pid,first);
    const settings=JSON.parse(fs.readFileSync(path.join(state,'daemon.json'),'utf8'));
    assert.ok(settings.args.includes('--root'));assert.ok(settings.args.includes(dir));assert.ok(settings.args.includes('127.0.0.1'));
    const sub=path.join(dir,'nested');fs.mkdirSync(sub);
    const status=spawnSync(process.execPath,[EXE,'status','--state',state],{cwd:sub,env:{...process.env,HATCH_STATE:''},encoding:'utf8'});
    assert.equal(status.status,0,status.stderr);assert.match(status.stdout,/running/);
    assert.equal(await stop(state),true);assert.equal(runningPid(state),null);
  } finally {await stop(state);}
});
test('broken saved settings do not stop a healthy daemon; stale control locks recover', async () => {
  const dir=tmp();const state=path.join(dir,'.hatch');fs.mkdirSync(state);fs.writeFileSync(path.join(state,'daemon-control.lock'),'999999999:stale');
  try {
    const r=await start(state,EXE,['--host','127.0.0.1','--port','0']);
    fs.writeFileSync(path.join(state,'daemon.json'),'{broken');
    await assert.rejects(restart(state,EXE),/cannot read/);assert.equal(runningPid(state),r.pid);
  } finally {await stop(state);}
});

test('new projects get distinct stable tmux sessions; existing session names survive', async () => {
  const { loadConfig } = await import('../src/state.js');
  const a = path.join(tmp(), '.hatch'); const b = path.join(tmp(), '.hatch');
  const first = loadConfig(a); const second = loadConfig(b);
  assert.match(first.session, /^hatch-[a-z0-9_-]+-[a-f0-9]{8}$/); assert.notEqual(first.session, second.session);
  assert.equal(loadConfig(a).session, first.session);
  assert.equal(loadConfig(a,{session:'my-existing-session'}).session, 'my-existing-session');
  assert.equal(loadConfig(a).session, 'my-existing-session');
});
