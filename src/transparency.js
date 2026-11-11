// Page translucency: transparency.json { "percent": 0..100, "windows": 0..100 } in the state dir (0 = opaque; the default is 30 so a background image shows).
// "windows" is optional: the transparency of windows that were not set one by one (leader o); absent = they follow "percent". The file is the
// source of truth, so `hatch set transparency N` and a hand edit both work; a bad file only warns and counts as the default.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './state.js';

const FILE = 'transparency.json';
export const DEFAULT_TRANSPARENCY = 30;
const D = DEFAULT_TRANSPARENCY;
export class TransparencyError extends Error { constructor(message) { super(message); this.name = 'TransparencyError'; } }
const RANGE = 'use a whole number from 0 (opaque) to 100 (fully transparent)';
const valid = (n) => Number.isInteger(n) && n >= 0 && n <= 100;

/** Reads the saved values: { percent, windows (null = follow percent), problem? }. Missing file = default without a problem; anything unusable = default with a message. */
export function readTransparency(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, FILE), 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { percent: D, windows: null } : { percent: D, windows: null, problem: `cannot read ${FILE}: ${e.code || e.message}; using ${D}` }; }
  let data; try { data = JSON.parse(raw); } catch { return { percent: D, windows: null, problem: `${FILE} is not valid JSON; write {"percent":30} or run \`hatch set transparency 30\` (using ${D})` }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { percent: D, windows: null };
  const out = { percent: D, windows: null }; const problems = [];
  if (data.percent !== undefined) { if (valid(data.percent)) out.percent = data.percent; else problems.push(`percent ${JSON.stringify(data.percent)} is not valid; ${RANGE} (using ${D})`); }
  if (data.windows !== undefined) { if (valid(data.windows)) out.windows = data.windows; else problems.push(`windows ${JSON.stringify(data.windows)} is not valid; ${RANGE}, or remove it to follow percent`); }
  if (problems.length) out.problem = `${FILE}: ${problems.join('; ')}`;
  return out;
}

const parse = (text) => { const n = /^\d{1,3}$/.test(String(text ?? '').trim()) ? Number(text) : NaN; if (!valid(n)) throw new TransparencyError(`invalid transparency ${JSON.stringify(text)}; ${RANGE}`); return n; };
const save = (dir, data) => { fs.mkdirSync(dir, { recursive: true }); atomicWrite(path.join(dir, FILE), `${JSON.stringify(data)}\n`); };

/** Validates the CLI text (digits only) and saves it; throws TransparencyError and writes nothing when it is bad. Keeps the windows default. */
export function setTransparency(dir, text) {
  const n = parse(text);
  const { windows } = readTransparency(dir);
  save(dir, windows === null ? { percent: n } : { percent: n, windows });
  return n;
}

/** Sets the transparency newly opened (and never individually set) windows get; the text "default" removes it so they follow the page again. Returns the number or null. */
export function setWindowTransparency(dir, text) {
  const n = String(text ?? '').trim() === 'default' ? null : parse(text);
  const { percent } = readTransparency(dir);
  save(dir, n === null ? { percent } : { percent, windows: n });
  return n;
}
