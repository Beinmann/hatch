// Schedules: run a command every N seconds and tell the user when its pass/fail status CHANGES (green to red, red to green).
// Definitions live in schedules.json: [{ "name": "tests", "cmd": "npm test", "everySec": 300, "always": false }]
// `always` notifies after every run. Runs are normal runs (listed, killable); the file is re-read when it changes.
import fs from 'node:fs';

const MIN_SEC = 10;

export function checkSchedules(list) {
  const defs = []; const errors = []; const seen = new Set();
  if (!Array.isArray(list)) return { defs, errors: ['schedules.json must be a JSON array'] };
  for (const [i, s] of list.entries()) {
    const name = typeof s?.name === 'string' && s.name.trim() ? s.name.trim() : null;
    if (!name) { errors.push(`entry ${i}: name is required`); continue; }
    if (seen.has(name)) { errors.push(`${name}: duplicate name (names must be unique)`); continue; }
    seen.add(name);
    if (typeof s.cmd !== 'string' || !s.cmd.trim()) { errors.push(`${name}: cmd is required`); continue; }
    const everySec = Number(s.everySec); if (!Number.isFinite(everySec * 1000) || !(everySec >= MIN_SEC)) { errors.push(`${name}: everySec must be finite and at least ${MIN_SEC}`); continue; }
    defs.push({ name, cmd: s.cmd, everySec, always: s.always === true });
  }
  return { defs, errors };
}

/** Parses 30s, 5m, 2h or a bare number of seconds. Returns seconds or null. */
export function parseEvery(text) {
  const m = /^(\d+(?:\.\d+)?)\s*([smh]?)$/i.exec(String(text).trim()); if (!m) return null;
  const seconds = Math.round(Number(m[1]) * ({ '': 1, s: 1, m: 60, h: 3600 }[m[2].toLowerCase()]));
  return Number.isSafeInteger(seconds) ? seconds : null;
}

export function createSchedules({ file, runs, notify, warn = () => {}, cwd, now = Date.now, tickMs = 1000 }) {
  let defs = []; let mtime = -1; let closed = false;
  const state = new Map(); // name -> { next, running, lastOk, cmd }

  function load() {
    if (closed) return;
    let st;
    try { st = fs.statSync(file); }
    catch {
      if (mtime !== 0) {
        defs = []; mtime = 0;
        for (const [name, entry] of state) if (!entry.running) state.delete(name);
        warn(null);
      }
      return;
    }
    if (st.mtimeMs === mtime) return; mtime = st.mtimeMs;
    try { const r = checkSchedules(JSON.parse(fs.readFileSync(file, 'utf8'))); defs = r.defs; warn(r.errors.length ? r.errors.join('; ') : null); } catch (e) { defs = []; warn(`invalid JSON: ${e.message}`); }
    // state of a schedule that is still running is kept even when the file is briefly invalid or the entry is edited, so a run is never duplicated
    for (const [n, s] of [...state]) if (!s.running && !defs.some((d) => d.name === n)) state.delete(n);
  }

  function runOne(d) {
    const s = state.get(d.name);
    s.running = true;
    try {
      runs.start(d.cmd, cwd, { quiet: true, timeoutSec: Math.max(d.everySec, 600), onDone: (code, r) => {
        if (!closed) load(); // direct edits may have removed this schedule since the last tick
        s.running = false;
        if (closed) return;
        if (!defs.some((active) => active.name === d.name && active.cmd === d.cmd)) {
          if (!defs.some((active) => active.name === d.name) && state.get(d.name) === s) state.delete(d.name);
          return;
        }
        s.last = { code, at: now(), runId: r.id };
        const ok = code === 0; const changed = s.lastOk !== undefined && s.lastOk !== ok;
        if (d.always || changed || (s.lastOk === undefined && !ok)) notify({ text: `${d.name}: ${ok ? (changed ? 'passing again' : 'passed') : `failed (exit ${code})`}`, level: ok ? 'done' : 'warn' });
        s.lastOk = ok;
      } });
    } catch (e) { s.running = false; warn(`${d.name}: cannot start: ${e.message}`); }
  }

  function tick() {
    if (closed) return;
    load();
    for (const d of defs) {
      let s = state.get(d.name);
      if (!s) { s = { next: now(), running: false, lastOk: undefined, cmd: d.cmd, last: null }; state.set(d.name, s); }
      else if (s.cmd !== d.cmd) { s.cmd = d.cmd; s.next = now(); } // edited command: same state (baseline and any run in flight), runs again soon
      s.next = Math.min(s.next, now() + d.everySec * 1000); // an interval edited to something shorter, or a clock stepped back, must not stall the schedule
      if (!s.running && now() >= s.next) { s.next = now() + d.everySec * 1000; runOne(d); }
    }
  }
  const timer = setInterval(tick, tickMs); timer.unref();
  return { tick, load, close: () => { closed = true; clearInterval(timer); }, status: () => defs.map((d) => ({ ...d, running: !!state.get(d.name)?.running, last: state.get(d.name)?.last || null, nextInSec: state.get(d.name) ? Math.max(0, Math.round((state.get(d.name).next - now()) / 1000)) : 0 })) };
}
