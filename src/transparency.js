// Page translucency: transparency.json { "percent": 0..100 } in the state dir (0 = opaque; the default is 30 so a background image shows). The file is the
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

/** Reads the saved value: { percent, problem? }. Missing file = default without a problem; anything unusable = default with a message. */
export function readTransparency(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, FILE), 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { percent: D } : { percent: D, problem: `cannot read ${FILE}: ${e.code || e.message}; using ${D}` }; }
  let data; try { data = JSON.parse(raw); } catch { return { percent: D, problem: `${FILE} is not valid JSON; write {"percent":30} or run \`hatch set transparency 30\` (using ${D})` }; }
  const p = data && typeof data === 'object' && !Array.isArray(data) ? data.percent : undefined;
  if (p === undefined && data && typeof data === 'object' && !Array.isArray(data)) return { percent: D };
  if (valid(p)) return { percent: p };
  return { percent: D, problem: `${FILE}: percent ${JSON.stringify(p)} is not valid; ${RANGE} (using ${D})` };
}

/** Validates the CLI text (digits only) and saves it; throws TransparencyError and writes nothing when it is bad. */
export function setTransparency(dir, text) {
  const n = /^\d{1,3}$/.test(String(text ?? '').trim()) ? Number(text) : NaN;
  if (!valid(n)) throw new TransparencyError(`invalid transparency ${JSON.stringify(text)}; ${RANGE}`);
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(path.join(dir, FILE), `${JSON.stringify({ percent: n })}\n`);
  return n;
}
