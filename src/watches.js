// Watches: notify the browser when the terminal output matches a pattern or has been idle for a while.
// (Emacs compilation-mode / VS Code problem matchers, reduced to "tell me".) Definitions live in watches.json:
//   [{ "name": "failed", "pattern": "FAIL|Error", "level": "warn", "cooldownSec": 30 }, { "name": "idle", "idleSec": 20 }]
// The file is re-read when it changes, so `hatch watch add` takes effect at once.
import fs from 'node:fs';
import { stripAnsi as stripEscapes, createAnsiStripper } from '../public/ansi.js';

export const stripAnsi = (s) => stripEscapes(s).replace(/\r/g, '');
const TAIL = 4096;

/** Validates a list of definitions. Returns { defs, errors }. */
export function checkWatches(list) {
  const defs = []; const errors = [];
  if (!Array.isArray(list)) return { defs, errors: ['watches.json must be a JSON array'] };
  for (const [i, w] of list.entries()) {
    const name = typeof w?.name === 'string' && w.name.trim() ? w.name.trim() : null;
    if (!name) { errors.push(`entry ${i}: name is required`); continue; }
    const d = { name, level: ['info', 'warn', 'done'].includes(w.level) ? w.level : 'info', cooldownSec: Math.max(1, Number(w.cooldownSec) || 30) };
    if (typeof w.pattern === 'string' && w.pattern) {
      try { d.re = new RegExp(w.pattern, 'gi'); d.pattern = w.pattern; } catch (e) { errors.push(`${name}: bad pattern: ${e.message}`); continue; }
    }
    if (Number(w.idleSec) > 0) d.idleSec = Number(w.idleSec);
    if (!d.re && !d.idleSec) { errors.push(`${name}: needs a pattern or idleSec`); continue; }
    defs.push(d);
  }
  return { defs, errors };
}

export function createWatches({ file, notify, warn = () => {}, now = Date.now, tickMs = 1000 }) {
  let defs = []; let mtime = -1; let lastOutput = null;
  const decoder = new TextDecoder(); const cleaner = createAnsiStripper(); const tails = new Map();
  const idleDone = new Set(); // idle watches that already fired for the current quiet period
  const lastFire = new Map();

  function load() {
    let st; try { st = fs.statSync(file); } catch { if (mtime !== 0) { defs = []; tails.clear(); mtime = 0; warn(null); } return; }
    if (st.mtimeMs === mtime) return;
    mtime = st.mtimeMs;
    try {
      const r = checkWatches(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (!r.errors.length) { defs = r.defs; tails.clear(); }
      warn(r.errors.length ? r.errors.join('; ') : null);
    } catch (e) { warn(`invalid JSON: ${e.message}`); }
  }
  const fire = (d, text) => {
    const t = now();
    if ((lastFire.get(d.name) ?? -Infinity) + d.cooldownSec * 1000 > t) return;
    lastFire.set(d.name, t);
    notify({ text, level: d.level });
  };

  function feed(buf) {
    load();
    lastOutput = now(); idleDone.clear();
    const clean = cleaner.push(decoder.decode(buf, { stream: true })).replace(/\r/g, '');
    if (!clean) return;
    for (const d of defs) {
      if (!d.re) continue;
      const text = (tails.get(d) || '') + clean;
      d.re.lastIndex = 0; let consumed = 0; let first = true; let match;
      while ((match = d.re.exec(text))) {
        if (first) { fire(d, `${d.name}: ${match[0].slice(0, 120)}`); first = false; }
        consumed = match.index + match[0].length;
        if (!match[0].length) d.re.lastIndex++; // zero-length patterns must also make progress
      }
      tails.set(d, text.slice(consumed).slice(-TAIL));
    }
  }

  function tick() {
    load();
    if (lastOutput === null) return;
    for (const d of defs) {
      if (d.idleSec && !idleDone.has(d.name) && now() - lastOutput >= d.idleSec * 1000) { idleDone.add(d.name); fire(d, `${d.name}: no terminal output for ${d.idleSec}s`); }
    }
  }
  const timer = setInterval(tick, tickMs); timer.unref();
  return { feed, tick, load, close: () => clearInterval(timer), defs: () => defs };
}
