// Data sources for widgets: metric (built-ins from /proc), exec (a shell command polled), tail (new lines of a file),
// file (whole file when it changes). Sources are shared: two widgets on `metric:cpu` run one sampler, and a sampler
// stops when its last subscriber leaves. `exec` is arbitrary command execution BY DESIGN in V0.1 (see the security warning in the README).
import fs from 'node:fs';
import { exec as execCb } from 'node:child_process';
import { ports as listPorts } from './discover.js';

const MIN_MS = 500;
const EXEC_MAX = 64 * 1024;
const FILE_MAX = 256 * 1024;
const TAIL_KEEP = 200;

// ---- pure parsers (tested against fixtures) ----
export function parseCpu(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^(cpu\d*)\s+(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    const idle = (v[3] || 0) + (v[4] || 0);
    out.push({ name: m[1], idle, total: v.reduce((a, b) => a + b, 0) });
  }
  return out;
}
export function cpuPct(prev, cur) {
  const pct = (a, b) => (b.total - a.total > 0 ? Math.round((1000 * (1 - (b.idle - a.idle) / (b.total - a.total))) ) / 10 : 0);
  const find = (arr, n) => arr.find((x) => x.name === n);
  const total = prev && find(prev, 'cpu') && find(cur, 'cpu') ? pct(find(prev, 'cpu'), find(cur, 'cpu')) : 0;
  const cores = cur.filter((c) => c.name !== 'cpu').map((c) => (prev && find(prev, c.name) ? pct(find(prev, c.name), c) : 0));
  return { total, cores };
}
export function parseMem(text) {
  const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0) * 1024;
  const total = kb('MemTotal'); const available = kb('MemAvailable');
  const swapTotal = kb('SwapTotal'); const swapUsed = swapTotal - kb('SwapFree');
  return { total, available, used: total - available, pct: total ? Math.round((1000 * (total - available)) / total) / 10 : 0, swapTotal, swapUsed };
}
export function parseLoad(text) { const [l1, l5, l15] = text.trim().split(/\s+/).map(Number); return { l1, l5, l15 }; }
export function parseNet(text) {
  let rx = 0; let tx = 0;
  for (const line of text.split('\n').slice(2)) {
    const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!m || m[1] === 'lo') continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    rx += v[0] || 0; tx += v[8] || 0;
  }
  return { rx, tx };
}

const read = (root, f) => fs.readFileSync(`${root}/${f}`, 'utf8');

/** One sampler: `sample()` returns the next value (maybe async). Keeps its own state between calls. */
function metricSampler(def, root) {
  let prevCpu = null; let prevNet = null; let prevAt = 0;
  switch (def.id) {
    case 'cpu': return () => { const cur = parseCpu(read(root, 'stat')); const v = cpuPct(prevCpu, cur); prevCpu = cur; return v; };
    case 'mem': return () => parseMem(read(root, 'meminfo'));
    case 'load': return () => parseLoad(read(root, 'loadavg'));
    case 'ports': return () => ({ ports: listPorts(root) });
    case 'disk': return async () => {
      const s = await fs.promises.statfs(def.path || '/');
      const total = s.blocks * s.bsize; const free = s.bavail * s.bsize;
      return { path: def.path || '/', total, used: total - free, pct: total ? Math.round((1000 * (total - free)) / total) / 10 : 0 };
    };
    case 'net': return () => {
      const cur = parseNet(read(root, 'net/dev')); const now = Date.now();
      const dt = prevNet ? (now - prevAt) / 1000 : 0;
      const v = { rxBps: dt ? Math.max(0, Math.round((cur.rx - prevNet.rx) / dt)) : 0, txBps: dt ? Math.max(0, Math.round((cur.tx - prevNet.tx) / dt)) : 0, rx: cur.rx, tx: cur.tx };
      prevNet = cur; prevAt = now; return v;
    };
    default: return null;
  }
}

/** A readable reason instead of a raw errno: names the file and says how to fix it. */
export function readError(file, e) {
  const why = { ENOENT: 'the file does not exist', EACCES: 'permission denied', EPERM: 'permission denied', EISDIR: 'it is a directory' }[e.code];
  return why ? `cannot read ${file}: ${why}; point the source path in widget.json at a readable file` : `cannot read ${file}: ${e.code || e.message}`;
}
export const METRICS = ['cpu', 'mem', 'load', 'disk', 'net', 'ports'];

/** A source definition as written in widget.json, validated. Returns { def } or { error }. */
export function checkSource(d) {
  if (!d || typeof d !== 'object') return { error: 'a source must be an object' };
  const kind = d.kind;
  const everyMs = Math.max(MIN_MS, Number.isFinite(d.everyMs) ? d.everyMs : 1000);
  if (kind === 'metric') { if (!METRICS.includes(d.id)) return { error: `unknown metric ${d.id}; known: ${METRICS.join(', ')}` }; return { def: { kind, id: d.id, path: d.path, everyMs } }; }
  if (kind === 'exec') { if (typeof d.cmd !== 'string' || !d.cmd) return { error: 'exec sources need cmd' }; return { def: { kind, cmd: d.cmd, json: !!d.json, everyMs, timeoutMs: Math.min(30000, d.timeoutMs || 10000) } }; }
  if (kind === 'tail' || kind === 'file') { if (typeof d.path !== 'string' || !d.path) return { error: `${kind} sources need path` }; return { def: { kind, path: d.path, everyMs: Math.max(MIN_MS, d.everyMs || 500) } }; }
  return { error: `unknown source kind ${kind}; use metric, exec, tail or file` };
}

/** Arguments a widget may pass to hatch.call: a plain file-name-like word, so a command can use it in a path without
 *  being able to climb out of a folder (no slash, no leading dot) or add shell syntax. */
export const ARG_RE = /^\w[\w. -]{0,199}$/;

/** Runs an exec definition once and calls `done({out, code, json?, error?})`. `arg` reaches the command as $HATCH_ARG
 *  (environment, never part of the shell text, so it cannot inject commands). */
function runExec(def, arg, done) {
  const env = arg === undefined ? process.env : { ...process.env, HATCH_ARG: arg };
  execCb(def.cmd, { timeout: def.timeoutMs, maxBuffer: EXEC_MAX, shell: '/bin/sh', env }, (err, stdout, stderr) => {
    const out = String(stdout || '').trim();
    const v = { out, code: err ? (err.code ?? 1) : 0, ...(err && { error: err.killed ? `timed out after ${def.timeoutMs} ms` : String(stderr || err.message).trim().slice(0, 500) }) };
    if (def.json && !err) { try { v.json = JSON.parse(out); } catch (e) { v.error = `output is not JSON: ${e.message}`; } }
    done(v);
  });
}

/** One-shot run of an exec source for hatch.call. Resolves with the same value shape a subscription delivers. */
export function runOnce(def, arg) {
  return new Promise((resolve) => runExec(def, arg, resolve));
}

const keyOf = (d) => JSON.stringify([d.kind, d.id, d.cmd, d.path, d.everyMs, d.json]);

export function createSources({ procRoot = '/proc' } = {}) {
  const running = new Map(); // key -> { subs:Set, last, stop }

  function makeLoop(def, publish) {
    if (def.kind === 'metric') {
      const sample = metricSampler(def, procRoot);
      const tick = async () => { try { publish(await sample()); } catch (e) { publish({ error: e.message }); } };
      tick();
      const timer = setInterval(tick, def.everyMs);
      return { stop: () => clearInterval(timer) };
    }
    if (def.kind === 'exec') {
      let busy = false;
      const tick = () => {
        if (busy) return; // one run at a time per source
        busy = true;
        runExec(def, undefined, (v) => { busy = false; publish(v); });
      };
      tick();
      const timer = setInterval(tick, def.everyMs);
      return { stop: () => clearInterval(timer) };
    }
    if (def.kind === 'file') {
      let sig = '';
      const tick = () => {
        try {
          const st = fs.statSync(def.path); const s = `${st.size}:${st.mtimeMs}`;
          if (s === sig) return; sig = s;
          const fd = fs.openSync(def.path, 'r'); const buf = Buffer.alloc(Math.min(st.size, FILE_MAX));
          fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
          publish({ text: buf.toString('utf8'), truncated: st.size > FILE_MAX });
        } catch (e) { if (sig !== 'err') { sig = 'err'; publish({ error: readError(def.path, e) }); } }
      };
      tick();
      const timer = setInterval(tick, def.everyMs);
      return { stop: () => clearInterval(timer) };
    }
    // tail: remember the last lines for late subscribers, then send only what is appended
    let pos = -1; const lines = []; let partial = ''; let lastErr = '';
    const tick = () => {
      try {
        const st = fs.statSync(def.path);
        if (pos < 0) pos = Math.max(0, st.size - 64 * 1024);
        if (st.size < pos) pos = 0; // truncated or rotated
        if (st.size === pos) return;
        const fd = fs.openSync(def.path, 'r'); const buf = Buffer.alloc(Math.min(st.size - pos, FILE_MAX));
        fs.readSync(fd, buf, 0, buf.length, pos); fs.closeSync(fd); pos += buf.length;
        const parts = (partial + buf.toString('utf8')).split('\n'); partial = parts.pop();
        if (!parts.length) return;
        lines.push(...parts); if (lines.length > TAIL_KEEP) lines.splice(0, lines.length - TAIL_KEEP);
        publish({ lines: parts, append: true }, { lines: [...lines], append: false });
        lastErr = '';
      } catch (e) {
        // once per distinct failure (not every tick); pos resets so a file that appears later is read from its tail
        const msg = readError(def.path, e); pos = -1;
        if (msg !== lastErr) { lastErr = msg; publish({ error: msg }); }
      }
    };
    tick();
    const timer = setInterval(tick, def.everyMs);
    return { stop: () => clearInterval(timer) };
  }

  /** Subscribes `fn(value, ts)`; a late subscriber immediately gets the last value. Returns unsubscribe. */
  function subscribe(def, fn) {
    const key = keyOf(def);
    let s = running.get(key);
    if (!s) {
      s = { subs: new Set(), last: undefined, stop: null };
      running.set(key, s);
      // publish(live, replay): `replay` is what a late subscriber should see (tail keeps its buffer)
      s.stop = makeLoop(def, (v, replay) => { s.last = replay ?? v; const ts = Date.now(); for (const f of s.subs) f(v, ts); }).stop;
    }
    s.subs.add(fn);
    if (s.last !== undefined) fn(s.last, Date.now());
    return () => {
      s.subs.delete(fn);
      if (!s.subs.size) { s.stop(); running.delete(key); }
    };
  }

  return { subscribe, active: () => running.size, closeAll() { for (const s of running.values()) s.stop(); running.clear(); } };
}
