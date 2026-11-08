import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createTerminal } from '../src/terminal.js';
import { waitFor } from './helpers.js';

class Response extends EventEmitter {
  constructor() { super(); this.frames = []; this.block = false; this.destroyed = false; this.writableEnded = false; }
  writeHead() {}
  write(frame) { this.frames.push(frame); return !this.block; }
  end() { this.writableEnded = true; this.emit('finish'); this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  text() { return this.frames.filter(frame => frame.startsWith('data: ')).map(frame => Buffer.from(frame.slice(6).trim(), 'base64').toString()).join(''); }
}

const hasPython = spawnSync('python3', ['-V']).status === 0;
test('a slow terminal viewer disconnects without stopping the pty or healthy output delivery', { skip: !hasPython }, async () => {
  const script = "import sys,time\nprint('ready',flush=True)\ninput()\nsys.stdout.write('x'*3000000+'DONE\\n');sys.stdout.flush()\ntime.sleep(30)";
  const terminal = createTerminal({ attach: ['python3', '-u', '-c', script] }); const slow = new Response(); const healthy = new Response();
  try {
    terminal.watch(new EventEmitter(), slow); terminal.watch(new EventEmitter(), healthy);
    await waitFor(() => terminal.replay().toString().includes('ready'));
    slow.block = true; terminal.input('go\n');
    await waitFor(() => slow.destroyed && healthy.text().includes('DONE'), 5000);
    assert.equal(terminal.info().running, true); assert.equal(healthy.destroyed, false);
    assert.ok(healthy.text().includes('x'.repeat(1000))); terminal.stop(); assert.equal(healthy.destroyed, true);
  } finally { terminal.stop(); }
});

test('a terminal window with a command runs it directly, without tmux, and ends with the program', async () => {
  // tmuxBin points at a missing binary: any tmux call would throw, so passing proves no tmux is involved.
  const terminal = createTerminal({ command: 'echo direct-ok; sleep 0.2', tmuxBin: '/nonexistent/tmux' });
  terminal.ensure();
  assert.equal(terminal.alive(), true);
  await new Promise((r) => setTimeout(r, 1500));
  assert.match(terminal.replay().toString(), /direct-ok/);
  assert.equal(terminal.alive(), false);
  const long = createTerminal({ command: 'sleep 30', tmuxBin: '/nonexistent/tmux' });
  long.ensure(); assert.equal(long.alive(), true);
  long.kill(); await new Promise((r) => setTimeout(r, 500));
  assert.equal(long.alive(), false);
});
