// Long-lived processes owned by a widget (source kind "proc"). One process per widget window: it starts on the first
// subscribe or send, its stdout lines go to every subscriber, `hatch.call(source, text)` writes one line to its stdin, and it
// is killed when the window closes or the server stops. If it exits, the next subscribe or send starts a fresh one.
// Values delivered to subscribers: { line } for each stdout line, { exit: { code, signal, stderr } } when it ended.
import { spawn } from 'node:child_process';

export const PROC_LINE_MAX = 16 * 1024 * 1024; // longer stdout lines are dropped (the process should chunk its output)
export const PROC_SEND_MAX = 4 * 1024 * 1024;

export function createProcs({ cwd = process.cwd(), log = () => {} } = {}) {
  const procs = new Map(); // widget name -> { child, subs:Set, stderr }

  function start(name, def) {
    let p = procs.get(name); if (p) return p;
    const child = spawn('/bin/sh', ['-c', def.cmd], { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); // own process group: kill takes the whole tree
    p = { child, subs: new Set(), stderr: '', killTimer: null }; procs.set(name, p);
    const emit = (v) => { for (const f of [...p.subs]) { try { f(v, Date.now()); } catch (e) { log(`widget process ${name}: subscriber failed: ${e.message}`); } } };
    let pending = Buffer.alloc(0); let skipping = false;
    child.stdout.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let i;
      while ((i = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, i); pending = pending.subarray(i + 1);
        if (skipping) { skipping = false; continue; } // the tail of an overlong line
        emit({ line: line.toString('utf8') });
      }
      if (pending.length > PROC_LINE_MAX) { pending = Buffer.alloc(0); skipping = true; emit({ error: `a line longer than ${PROC_LINE_MAX} bytes was dropped` }); }
    });
    child.stderr.on('data', (c) => { p.stderr = (p.stderr + c.toString('utf8')).slice(-4000); });
    child.stdin.on('error', () => {}); // EPIPE when it already exited: the exit event tells the story
    let ended = false;
    const finish = (code, signal, why) => {
      if (ended) return; ended = true; clearTimeout(p.killTimer);
      if (procs.get(name) === p) procs.delete(name);
      emit({ exit: { code, signal, stderr: why || p.stderr.trim() } });
    };
    child.on('error', (e) => finish(null, null, `could not start: ${e.message}`));
    child.on('close', (code, signal) => finish(code, signal));
    return p;
  }

  return {
    /** Attach `fn(value, ts)`, starting the process if needed. Returns a function that detaches (the process keeps running). */
    subscribe(name, def, fn) { const p = start(name, def); p.subs.add(fn); return () => { p.subs.delete(fn); }; },
    /** Write one line to the process's stdin (starting it first if it is not running). */
    send(name, def, text) {
      if (typeof text !== 'string' || /[\r\n]/.test(text)) throw new Error('a line for a widget process must be one line of text');
      if (text.length > PROC_SEND_MAX) throw new Error(`a line for a widget process may be at most ${PROC_SEND_MAX} characters`);
      start(name, def).child.stdin.write(`${text}\n`);
    },
    running: (name) => procs.has(name),
    /** SIGTERM to the whole process group, SIGKILL two seconds later if it is still there. */
    kill(name) {
      const p = procs.get(name); if (!p) return;
      procs.delete(name); const { child } = p; p.subs.clear();
      const sig = (s) => { try { process.kill(-child.pid, s); } catch { /* already gone */ } };
      sig('SIGTERM');
      const t = setTimeout(() => sig('SIGKILL'), 2000); t.unref(); child.on('close', () => clearTimeout(t));
    },
    killAll() { for (const n of [...procs.keys()]) this.kill(n); },
  };
}
