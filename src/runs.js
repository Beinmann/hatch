// Runs: a command in its own live output window (Emacs compilation-mode idea) instead of the terminal.
// Output is kept (last 512 KB) for late viewers, the exit code is reported, and a finished run notifies the user.
// Arbitrary command execution by design, like exec sources (see the security warning in the README). Runs live in memory; a restart drops them.
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createSseWriter } from './sse.js';
import { appendOutput, retainedText, outputTail } from './run-output.js';

const MAX_RUNS = 30;
const MAX_TIMER_MS = 0x7fffffff; // larger delays overflow Node's timers to one millisecond

export function createRuns({ cwd, notify = () => {}, stopGraceMs = 2000 }) {
  if (!Number.isFinite(stopGraceMs) || stopGraceMs < 0 || stopGraceMs > MAX_TIMER_MS) throw new Error('stop grace period must be a finite non-negative number of milliseconds within the timer limit');
  const writers = new Set(); const runs = new Map(); let seq = 0; let closed = false;
  const boot = `${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`; // panel files outlive the server: ids must not repeat after a restart

  function start(cmd, dir, { quiet = false, onDone = null, timeoutSec = 0 } = {}) {
    if (closed) throw Object.assign(new Error('run manager is closed'), { status: 503 });
    if (typeof cmd !== 'string' || !cmd.trim()) throw Object.assign(new Error('run needs a command'), { status: 400 });
    if (typeof timeoutSec !== 'number' || !Number.isFinite(timeoutSec * 1000) || timeoutSec < 0) throw Object.assign(new Error('run timeout must be a finite non-negative number of seconds'), { status: 400 });
    const r = { id: `r${boot}x${++seq}`, cmd: cmd.slice(0, 2000), cwd: dir || cwd, quiet, state: 'running', code: null, started: Date.now(), chunks: [], bytes: 0, truncated: false, watchers: new Set(), proc: null, signal: null, stopping: false, stopTimer: null };
    const proc = spawn('/bin/sh', ['-c', cmd], { cwd: r.cwd, env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    r.proc = proc;
    const out = (buf) => {
      appendOutput(r, buf);
      for (const writer of r.watchers) writer.write(`data: ${buf.toString('base64')}\n\n`);
    };
    proc.stdout.on('data', out); proc.stderr.on('data', out);
    const done = (code, why) => {
      if (r.state !== 'running') return;
      clearTimeout(killer); clearTimeout(r.stopTimer);
      r.state = 'done'; r.code = code; r.ended = Date.now();
      if (why) out(Buffer.from(`\n[${why}]\n`));
      for (const writer of r.watchers) writer.end(`event: exit\ndata: ${code}\n\n`);
      const secs = ((r.ended - r.started) / 1000).toFixed(1);
      if (!quiet && !closed) notify({ text: `${r.cmd.slice(0, 80)} ${code === 0 ? 'finished' : `failed (exit ${code})`} in ${secs}s`, level: code === 0 ? 'done' : 'warn' });
      try { onDone?.(code, r); } catch { /* a hook must not break the run */ }
    };
    let killer = null;
    if (timeoutSec > 0) {
      const deadline = Date.now() + timeoutSec * 1000;
      const arm = () => {
        if (r.state !== 'running') return;
        const remaining = deadline - Date.now();
        if (remaining > 0) { killer = setTimeout(arm, Math.min(remaining, MAX_TIMER_MS)); return; }
        kill(r, 'SIGKILL');
        done(124, `timed out after ${timeoutSec}s`);
      };
      arm();
    }
    proc.on('error', (e) => done(127, `cannot start: ${e.message}`));
    proc.on('close', (code, sig) => { r.signal = sig || null; done(code ?? (sig ? 128 + (os.constants.signals[sig] || 0) : 1), sig ? `killed by ${sig}` : null); });
    runs.set(r.id, r);
    // user runs and background (quiet, scheduled) runs are trimmed separately so a 10 s schedule cannot push the user's runs out
    for (const quiet of [false, true]) { const group = [...runs.values()].filter((x) => x.quiet === quiet); let over = group.length - (quiet ? 10 : MAX_RUNS); for (const old of group) { if (over <= 0) break; if (old.state === 'done') { runs.delete(old.id); over--; } } }
    return view(r);
  }

  const view = (r) => ({ id: r.id, cmd: r.cmd, cwd: r.cwd, state: r.state, code: r.code, started: r.started, signal: r.signal, stopping: r.stopping && r.state === 'running' });
  const get = (id) => { const r = runs.get(id); if (!r) throw Object.assign(new Error(`no run ${id} (the server may have restarted); run it again`), { status: 404 }); return r; };

  function watch(id, req, res) {
    if (closed) throw Object.assign(new Error('run manager is closed'), { status: 503 });
    const r = get(id);
    const writer = createSseWriter(req, res, { onClose: () => { r.watchers.delete(writer); writers.delete(writer); } }); r.watchers.add(writer); writers.add(writer);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    writer.write('retry: 1000\n\n');
    if (r.truncated) writer.write('event: truncated\ndata: true\n\n');
    if (r.chunks.length) writer.write(`event: replay\ndata: ${Buffer.concat(r.chunks).toString('base64')}\n\n`);
    if (r.state === 'done') writer.end(`event: exit\ndata: ${r.code}\n\n`);
  }

  const kill = (r, signal) => {
    try { process.kill(-r.proc.pid, signal); }
    catch { try { r.proc.kill(signal); } catch { /* already gone */ } }
  };
  /** Give cleanup handlers a chance, then stop the whole group even when SIGTERM is ignored. */
  function stop(id) {
    const r = get(id);
    if (r.state === 'running' && !r.stopping) {
      r.stopping = true; kill(r, 'SIGTERM');
      r.stopTimer = setTimeout(() => { if (r.state === 'running') kill(r, 'SIGKILL'); }, stopGraceMs);
    }
    return view(r);
  }
  function stopAll() { for (const r of runs.values()) if (r.state === 'running') kill(r, 'SIGKILL'); }
  function close() { closed = true; for (const writer of [...writers]) writer.destroy(); stopAll(); }

  /** The kept output as text (ANSI stripped), at most the last `max` characters. */
  function output(id, max = 65536) { const r = get(id); return outputTail(retainedText(r), max); }

  return { output, start, watch, stop, stopAll, close, all: () => [...runs.values()].map((r) => ({ ...view(r), ended: r.ended || null })), get: (id) => view(get(id)), list: () => [...runs.values()].map(view) };
}
