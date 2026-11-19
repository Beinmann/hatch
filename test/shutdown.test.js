import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installCrashHandlers, createStop } from '../src/shutdown.js';

test('an uncaught exception or rejection is logged with its stack and does not stop the process', () => {
  const proc = new EventEmitter(); const lines = [];
  installCrashHandlers(proc, (m) => lines.push(m));
  assert.doesNotThrow(() => proc.emit('uncaughtException', new Error('boom in a timer')));
  proc.emit('unhandledRejection', new Error('rejected'));
  assert.match(lines[0], /uncaught exception.*keeps running.*boom in a timer[\s\S]*at /);
  assert.match(lines[1], /unhandled promise rejection.*rejected/);
});

test('a real throw in a timer is survived when the handler is installed', async () => {
  const { spawnSync } = await import('node:child_process');
  const code = `import { installCrashHandlers } from ${JSON.stringify(new URL('../src/shutdown.js', import.meta.url).href)};
    installCrashHandlers(process, (m) => console.log(m.split('\\n')[0]));
    setTimeout(() => { throw new Error('late'); }, 5); setTimeout(() => console.log('still alive'), 60);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /late/); assert.match(r.stdout, /still alive/);
});

test('stop exits 0 after close, and exits 1 within the timeout when close hangs or throws', async () => {
  let code; const exit = (c) => { code = c; };
  await createStop(async () => {}, { exit, log() {} })(); assert.equal(code, 0);

  code = undefined; const t0 = Date.now(); const lines = [];
  const hung = createStop(() => new Promise(() => {}), { timeoutMs: 50, exit, log: (m) => lines.push(m) })();
  await new Promise((r) => setTimeout(r, 200)); assert.equal(code, 1); assert.ok(Date.now() - t0 < 1000); assert.match(lines[0], /did not finish/);
  void hung;

  code = undefined; await createStop(async () => { throw new Error('nope'); }, { exit, log() {} })(); assert.equal(code, 1);
});

test('a second signal while stopping is ignored', async () => {
  let calls = 0; const stop = createStop(async () => { calls++; }, { exit() {}, log() {} });
  await Promise.all([stop(), stop()]); assert.equal(calls, 1);
});
