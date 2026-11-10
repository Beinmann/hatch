// Background effect for the terminal: fx.json { "effect": "matrix" } in the state dir. No file, or "off", means none. The file is
// the source of truth, so `hatch fx NAME`, the palette and a hand edit all work; a bad file only warns and counts as off.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './state.js';

const FILE = 'fx.json';
export const EFFECTS = ['matrix', 'rain']; // each one is public/fx/NAME.js
export class FxError extends Error { constructor(message) { super(message); this.name = 'FxError'; } }

/** { effect: name | null, problem? }. Missing file = off without a problem; anything unusable = off with a message. */
export function readFx(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, FILE), 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { effect: null } : { effect: null, problem: `cannot read ${FILE}: ${e.code || e.message}; no effect` }; }
  let data; try { data = JSON.parse(raw); } catch { return { effect: null, problem: `${FILE} is not valid JSON; write {"effect":"matrix"} or run \`hatch fx matrix\` (no effect for now)` }; }
  const v = data && typeof data === 'object' && !Array.isArray(data) ? data.effect : undefined;
  if (v === undefined || v === null || v === 'off') return { effect: null };
  if (EFFECTS.includes(v)) return { effect: v };
  return { effect: null, problem: `${FILE}: effect ${JSON.stringify(v)} is unknown; use one of ${EFFECTS.join(', ')} or "off" (no effect for now)` };
}

/** Saves the effect ('off' removes it); throws FxError and writes nothing for an unknown name. Returns the name or null. */
export function setFx(dir, name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (n !== 'off' && !EFFECTS.includes(n)) throw new FxError(`unknown effect ${JSON.stringify(name)}; use one of ${EFFECTS.join(', ')} or off`);
  fs.mkdirSync(dir, { recursive: true });
  if (n === 'off') { fs.rmSync(path.join(dir, FILE), { force: true }); return null; }
  atomicWrite(path.join(dir, FILE), `${JSON.stringify({ effect: n })}\n`);
  return n;
}
