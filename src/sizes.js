// Window sizes: the default per kind of window, and the size the user last gave that kind (sizes.json in the state dir,
// { "<kind>": { "w": 420, "h": 300, "dockH": 480 } }). The file is the source of truth, so a hand edit or deletion works;
// a broken file only warns and counts as "nothing remembered".
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'sizes.json';
const MIN = { w: 180, h: 90 }; const MAX = 8192;

// Defaults live here only; callers must not send w/h unless the user asked for a size, or it would beat the remembered one.
const DEFAULTS = {
  image: [640, 440], iframe: [640, 420], note: [360, 240], files: [420, 380], editor: [560, 380],
  output: [560, 300], 'output:diff': [680, 360], terminal: [640, 360], vim: [700, 440], git: [420, 420],
  trash: [380, 320], page: [640, 460], progress: [620, 480], widget: [420, 300],
};

/** Kind key: the type, refined where one type holds very different content (widget name, output kind, vim). */
export function sizeKey(type, props, id) {
  if (type === 'widget' && typeof props?.name === 'string') return `widget:${props.name}`;
  if (type === 'output' && typeof props?.kind === 'string') return `output:${props.kind}`;
  if (type === 'terminal' && typeof props?.name === 'string' && props.name.startsWith('vim-')) return 'vim';
  return type;
}

export function defaultSize(key) {
  const k = String(key);
  const d = DEFAULTS[k] || DEFAULTS[k.split(':')[0]] || DEFAULTS.image;
  return { w: d[0], h: d[1] };
}

const okW = (n) => Number.isFinite(n) && n >= MIN.w && n <= MAX;
const okH = (n) => Number.isFinite(n) && n >= MIN.h && n <= MAX;

/** { sizes, problem? }. Missing file = empty; unusable entries are dropped with a message. */
export function readSizes(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, FILE), 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { sizes: {} } : { sizes: {}, problem: `cannot read ${FILE}: ${e.code || e.message}; using default sizes` }; }
  let data; try { data = JSON.parse(raw); } catch { return { sizes: {}, problem: `${FILE} is not valid JSON; delete it or write {"image":{"w":600,"h":400}} (using default sizes)` }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { sizes: {}, problem: `${FILE} must be an object of kind -> {w,h}; delete it to start over (using default sizes)` };
  const sizes = {}; const bad = [];
  for (const [k, v] of Object.entries(data)) {
    if (!v || typeof v !== 'object') { bad.push(k); continue; }
    const e = {};
    if (okW(v.w)) e.w = v.w; if (okH(v.h)) e.h = v.h; if (okH(v.dockH)) e.dockH = v.dockH;
    if (Object.keys(e).length) sizes[k] = e; else bad.push(k);
  }
  return { sizes, ...(bad.length && { problem: `${FILE}: ignored ${bad.join(', ')} (need w 180-8192 and h 90-8192); using default sizes for them` }) };
}

/** Size to open a new window at: remembered (docked: only a height) or the default for the kind. */
export function sizeFor(dir, key, placement) {
  const base = defaultSize(key); const r = readSizes(dir).sizes[String(key)] || {};
  if (placement === 'dock') return { w: base.w, h: r.dockH ?? base.h };
  return { w: r.w ?? base.w, h: r.h ?? base.h };
}

/** Saves a deliberate resize. Docked windows only have a height (stored as dockH). Bad numbers are ignored. */
export function rememberSize(dir, key, { w, h }, placement, write) {
  const cur = readSizes(dir).sizes; const e = { ...cur[key] };
  if (placement === 'dock') { if (okH(h)) e.dockH = h; } else { if (okW(w)) e.w = w; if (okH(h)) e.h = h; }
  cur[key] = e;
  write(path.join(dir, FILE), `${JSON.stringify(cur, null, 2)}\n`);
}
