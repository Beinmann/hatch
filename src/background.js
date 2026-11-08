// The page background: one image kept as background.<ext> in the state dir. The file is the source of truth, so
// `hatch set background`, the API and a hand copy all work; the state watcher turns changes into a `background` event.
import fs from 'node:fs';
import path from 'node:path';
import { sniff, MAX_BYTES } from './uploads.js';
import { atomicWrite } from './state.js';

const FILE_RE = /^background\.(png|jpg|gif|webp)$/;
export class BackgroundError extends Error { constructor(message) { super(message); this.name = 'BackgroundError'; } }

/** Validates `buf` by its magic bytes and publishes it as background.<ext>; the previous one is removed only after the new one is in place. */
export function setBackground(dir, buf) {
  if (buf.length > MAX_BYTES) throw new BackgroundError(`image is larger than ${MAX_BYTES / 1024 / 1024} MB; resize it and try again`);
  const ext = sniff(buf);
  if (!ext) throw new BackgroundError('not a PNG, JPEG, GIF or WebP image (checked the file header); convert it first, for example with ImageMagick: convert in.bmp out.png');
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(path.join(dir, `background.${ext}`), buf);
  for (const f of fs.readdirSync(dir)) if (FILE_RE.test(f) && f !== `background.${ext}`) fs.rmSync(path.join(dir, f), { force: true });
  return `background.${ext}`;
}

/** Reads a file for setBackground with messages that say what to fix. */
export function readImageFile(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { throw new BackgroundError(e.code === 'ENOENT' ? `no such file: ${file}; check the path` : `cannot read ${file}: ${e.code || e.message}`); }
  if (!st.isFile()) throw new BackgroundError(`not a regular file: ${file}; pass an image file`);
  try { return fs.readFileSync(file); } catch (e) { throw new BackgroundError(`cannot read ${file}: ${e.code || e.message}; check its permissions`); }
}

/**
 * Looks at the state dir: { name, rev } for a valid image, { name: null } when there is none, { name: null, problem }
 * when a background file exists but is not an image (hand edit gone wrong: the caller warns, the page shows none).
 */
export function findBackground(dir) {
  let names = []; try { names = fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).sort(); } catch { return { name: null }; }
  let problem = null;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file); const fd = fs.openSync(file, 'r');
      try {
        const head = Buffer.alloc(Math.min(st.size, 64)); fs.readSync(fd, head, 0, head.length, 0);
        if (sniff(head) === name.split('.')[1]) return { name, rev: Math.round(st.mtimeMs) };
      } finally { fs.closeSync(fd); }
      problem = `${name} is not a valid ${name.split('.')[1].toUpperCase()} image; replace it with \`hatch set background IMAGE\` or delete it`;
    } catch (e) { problem = `cannot read ${name}: ${e.code || e.message}`; }
  }
  return { name: null, ...(problem && { problem }) };
}

// ---- fit mode: background.json { "mode": "fill" } next to the image; hand edits work, a bad file only warns ----
export const MODES = ['fill', 'fit', 'stretch', 'center', 'tile'];
export const DEFAULT_MODE = 'fill'; // fill = CSS cover, what the page did before modes existed
const MODE_FILE = 'background.json';

/** Reads the fit mode: { mode, problem? }. A missing file is the default without a problem; anything unusable falls back with a message. */
export function readMode(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, MODE_FILE), 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { mode: DEFAULT_MODE } : { mode: DEFAULT_MODE, problem: `cannot read ${MODE_FILE}: ${e.code || e.message}; using ${DEFAULT_MODE}` }; }
  let data; try { data = JSON.parse(raw); } catch { return { mode: DEFAULT_MODE, problem: `${MODE_FILE} is not valid JSON; write {"mode":"fill"} or run \`hatch set background-mode fill\` (using ${DEFAULT_MODE})` }; }
  const mode = data && typeof data === 'object' ? data.mode : undefined;
  if (mode === undefined && data && typeof data === 'object' && !Array.isArray(data)) return { mode: DEFAULT_MODE };
  if (MODES.includes(mode)) return { mode };
  return { mode: DEFAULT_MODE, problem: `${MODE_FILE}: unknown mode ${JSON.stringify(mode)}; use one of ${MODES.join(', ')} (using ${DEFAULT_MODE})` };
}

export function setMode(dir, mode) {
  if (!MODES.includes(mode)) throw new BackgroundError(`unknown mode ${JSON.stringify(mode)}; use one of ${MODES.join(', ')}`);
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(path.join(dir, MODE_FILE), `${JSON.stringify({ mode })}\n`);
}

/** Removes the image (the mode file stays, so the next image keeps the chosen fit). Returns whether anything was removed. */
export function clearBackground(dir) {
  let removed = false;
  try { for (const f of fs.readdirSync(dir)) if (FILE_RE.test(f)) { fs.rmSync(path.join(dir, f), { force: true }); removed = true; } } catch { /* no state dir yet: nothing to clear */ }
  return removed;
}
