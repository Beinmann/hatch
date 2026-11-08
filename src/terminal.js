// One pty attached to one named tmux session, bridged to the browser (SSE for output, POST for input).
// Node has no pty, so src/ptyhost.py (python3, standard library only) owns it. Windows and panes belong to tmux,
// not to the web UI, which is where persistence comes from: the pty may die and be re-attached, the session stays.
// Reduced to the tmux-only case. `attach` (an argv array) can replace the
// tmux attach command, which is how the tests run a plain `cat` without tmux.
import { spawn, execFileSync } from 'node:child_process';
import { createSseWriter } from './sse.js';
import { fileURLToPath } from 'node:url';

const HOST = fileURLToPath(new URL('./ptyhost.py', import.meta.url));
const KEEP = 256 * 1024; // output kept for a browser that attaches late or reconnects

const size = (v, dflt, max) => (Number.isInteger(v) && v >= 1 && v <= max ? v : dflt);

export class TerminalError extends Error {}

export function createTerminal({ session = 'hatch', cwd = process.cwd(), env = {}, attach = null, tmuxBin = 'tmux', python = 'python3', cols = 120, rows = 32, onOutput = () => {}, command = null } = {}) {
  let t = null; // the running pty: { proc, chunks, bytes, watchers, state, exitCode }
  const watchers = new Set(); // survive a pty restart: a reconnecting client gets `exit`, then reattaches
  let size_ = { cols, rows };

  const tm = (args) => execFileSync(tmuxBin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  /** Makes sure the tmux session exists. Env vars go in with -e (tmux 3.2+); older tmux gets set-environment only. */
  function ensureSession() {
    try { tm(['has-session', '-t', `=${session}`]); } catch {
      const vars = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      const base = ['new-session', '-d', '-s', session, '-c', cwd, '-x', String(size_.cols), '-y', String(size_.rows)];
      const tail = command ? [command] : []; // an optional shell command to run in the first window (terminal windows)
      try { tm([...base, ...vars, ...tail]); } catch (e) {
        if (/unknown option|usage/i.test(String(e.stderr))) tm([...base, ...tail]);
        else throw new TerminalError(`tmux failed to create session ${session}: ${String(e.stderr || e.message).trim()}. Is tmux installed?`);
      }
    }
    // Existing windows only see new variables in new windows; documented in the README.
    for (const [k, v] of Object.entries(env)) { try { tm(['set-environment', '-t', session, k, v]); } catch { /* best effort */ } }
    try { tm(['set-option', '-t', session, 'window-size', 'latest']); } catch { /* older tmux */ }
    // Runtime only (never ~/.tmux.conf): with tmux's default `external`, programs inside tmux cannot set the browser clipboard through OSC 52.
    try { tm(['set-option', '-s', 'set-clipboard', 'on']); } catch { /* older tmux */ }
  }

  // A terminal window with a command (top, vim) runs it straight in the pty helper: no helper tmux session or status bar.
  // Trade-off: the program does not survive a server restart (the replay buffer still covers a browser reload).
  const direct = !attach && !!command;

  function start() {
    const argv = attach || (direct ? ['sh', '-c', command] : [tmuxBin, 'attach-session', '-t', session]);
    const cur = { chunks: [], bytes: 0, state: 'running', exitCode: null, proc: null };
    const proc = spawn(python, ['-I', HOST, cwd, String(size_.cols), String(size_.rows), ...argv], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'], cwd, env: { ...process.env, ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    cur.proc = proc;
    const out = (buf) => {
      try { onOutput(buf); } catch { /* a watcher must never break the terminal */ }
      cur.chunks.push(buf); cur.bytes += buf.length;
      while (cur.bytes > KEEP && cur.chunks.length > 1) cur.bytes -= cur.chunks.shift().length;
      const line = `data: ${buf.toString('base64')}\n\n`;
      for (const writer of watchers) writer.write(line);
    };
    proc.stdout.on('data', out);
    proc.stderr.on('data', out);
    for (const s of [proc.stdin, proc.stdio[3]]) s.on('error', () => { /* the process is gone */ }); // EPIPE after exit
    const done = (code, why) => {
      if (cur.state !== 'running') return;
      cur.state = 'exited'; cur.exitCode = code;
      if (why) out(Buffer.from(`\r\n[${why}]\r\n`));
      for (const writer of watchers) writer.end(`event: exit\ndata: ${code}\n\n`);
    };
    proc.on('error', (e) => done(127, e.code === 'ENOENT' ? `the terminal needs ${python} (not found)` : `cannot start: ${e.message}`));
    proc.on('close', (code) => done(code ?? 1, direct ? `exited with code ${code ?? 1}` : `detached or exited with code ${code ?? 1}; reconnect to attach again`));
    t = cur;
  }

  /** Session exists and a pty is attached; restarts the attach after the pty ended. */
  function ensure() {
    if (direct) { if (!t) start(); } // an exited program is not restarted: the window is gone (alive() is false)
    else if (!t || t.state !== 'running') { if (!attach) ensureSession(); start(); } // tmux is only consulted when a pty must be (re)attached
    return info();
  }

  /** False once the tmux session is gone (the program in a terminal window ended); a mere detach leaves it true. */
  function alive() { if (attach) return true; if (direct) return !t || t.state === 'running'; try { tm(['has-session', '-t', `=${session}`]); return true; } catch { return false; } }

  const info = () => ({ session, running: !!t && t.state === 'running', cols: size_.cols, rows: size_.rows });

  function watch(req, res) {
    ensure();
    const writer = createSseWriter(req, res, { onClose: () => watchers.delete(writer) }); watchers.add(writer);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    writer.write('retry: 1000\n\n');
    // Replay is separate so terminal-query replies from old output never reach the shell again.
    if (t.chunks.length) writer.write(`event: replay\ndata: ${Buffer.concat(t.chunks).toString('base64')}\n\n`);
    if (t.state !== 'running') writer.end(`event: exit\ndata: ${t.exitCode}\n\n`);
  }

  function input(data) {
    if (typeof data !== 'string') throw new TerminalError('data must be a string');
    ensure();
    t.proc.stdin.write(data);
  }

  function resize(c, r) {
    c = size(c, 0, 500); r = size(r, 0, 200);
    if (!c || !r) throw new TerminalError('cols and rows must be positive integers');
    size_ = { cols: c, rows: r };
    if (t && t.state === 'running') t.proc.stdio[3].write(`${c} ${r}\n`);
    return info();
  }

  /** Ends the pty and kills the tmux session (used by terminal windows: closing the window for good). */
  function kill() { stop(); if (!attach && !direct) { try { tm(['kill-session', '-t', `=${session}`]); } catch { /* already gone */ } } }

  /** Ends the pty only; the tmux session keeps running. */
  function stop() { if (t && t.state === 'running') t.proc.kill('SIGTERM'); for (const writer of [...watchers]) writer.destroy(); }

  return { ensure, info, alive, watch, input, resize, stop, kill, tmux: tm, setEnv: (e) => Object.assign(env, e), replay: () => (t ? Buffer.concat(t.chunks) : Buffer.alloc(0)) };
}
