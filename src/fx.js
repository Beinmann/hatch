// Background effect for the terminal: fx.json { "effect": "rain", "intensity": { "rain": 30 } } in the state dir. No file, or "off", means
// none. Intensity (0..100, default 50) is kept per effect, so switching effects keeps each one's setting; a plain { "effect": "matrix" }
// works too. The file is the source of truth, so `hatch fx NAME`, the palette and a hand edit all work; a bad file only warns.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './state.js';

const FILE = 'fx.json';
export const EFFECTS = ['matrix', 'rain', 'goo', 'snow', 'starfield', 'aurora', 'fireflies', 'embers', 'waves']; // each one is public/fx/NAME.js
export const DEFAULT_INTENSITY = 50;
export class FxError extends Error { constructor(message) { super(message); this.name = 'FxError'; } }

/** A whole number 0..100 from a number or numeric string, else null. */
export function parseIntensity(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : null;
}

/** { effect: name | null, intensity (of the active effect), intensities: { name: n }, problem? }. Missing file = off without a problem;
 *  anything unusable = off (or the default intensity) with a message. */
export function readFx(dir) {
  const off = (problem) => ({ effect: null, intensity: DEFAULT_INTENSITY, intensities: {}, ...(problem ? { problem } : {}) });
  let raw;
  try { raw = fs.readFileSync(path.join(dir, FILE), 'utf8'); } catch (e) { return e.code === 'ENOENT' ? off() : off(`cannot read ${FILE}: ${e.code || e.message}; no effect`); }
  let data; try { data = JSON.parse(raw); } catch { return off(`${FILE} is not valid JSON; write {"effect":"matrix"} or run \`hatch fx matrix\` (no effect for now)`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return off();
  const problems = []; const intensities = {};
  const raw_i = data.intensity;
  if (raw_i !== undefined && raw_i !== null) {
    if (typeof raw_i === 'object' && !Array.isArray(raw_i)) {
      for (const [name, v] of Object.entries(raw_i)) {
        if (!EFFECTS.includes(name)) { problems.push(`intensity for unknown effect ${JSON.stringify(name)} is ignored`); continue; }
        const n = parseIntensity(v);
        if (n === null) problems.push(`intensity of ${name} must be a number from 0 to 100 (using ${DEFAULT_INTENSITY})`); else intensities[name] = n;
      }
    } else { // a bare number means the active effect's intensity
      const n = parseIntensity(raw_i);
      if (n === null) problems.push(`intensity must be a number from 0 to 100 (using ${DEFAULT_INTENSITY})`); else if (EFFECTS.includes(data.effect)) intensities[data.effect] = n;
    }
  }
  const v = data.effect;
  let effect = null;
  if (v === undefined || v === null || v === 'off') effect = null;
  else if (EFFECTS.includes(v)) effect = v;
  else problems.push(`effect ${JSON.stringify(v)} is unknown; use one of ${EFFECTS.join(', ')} or "off" (no effect for now)`);
  const res = { effect, intensity: effect ? (intensities[effect] ?? DEFAULT_INTENSITY) : DEFAULT_INTENSITY, intensities };
  if (problems.length) res.problem = `${FILE}: ${problems.join('; ')}`;
  return res;
}

/** Saves the effect ('off' switches it off) and/or its intensity; name undefined keeps the active effect (an intensity then needs one).
 *  Throws FxError and writes nothing for a bad name or value. Other effects keep their intensity. Returns { effect, intensity }. */
export function setFx(dir, name, intensity) {
  const cur = readFx(dir);
  let effect = cur.effect;
  if (name !== undefined && name !== null) {
    const n = String(name).trim().toLowerCase();
    if (n !== 'off' && !EFFECTS.includes(n)) throw new FxError(`unknown effect ${JSON.stringify(name)}; use one of ${EFFECTS.join(', ')} or off`);
    effect = n === 'off' ? null : n;
  }
  const intensities = { ...cur.intensities };
  if (intensity !== undefined && intensity !== null) {
    const n = parseIntensity(intensity);
    if (n === null) throw new FxError(`intensity must be a number from 0 to 100 (got ${JSON.stringify(intensity)})`);
    if (!effect) throw new FxError('no effect is active; name one, e.g. `hatch fx rain --intensity 30`');
    intensities[effect] = n;
  }
  if (name === undefined && intensity === undefined) throw new FxError('give an effect name and/or an intensity');
  fs.mkdirSync(dir, { recursive: true });
  if (!effect && !Object.keys(intensities).length) fs.rmSync(path.join(dir, FILE), { force: true });
  else {
    const body = { effect: effect || 'off' };
    if (Object.keys(intensities).length) body.intensity = intensities;
    atomicWrite(path.join(dir, FILE), `${JSON.stringify(body)}\n`);
  }
  return { effect, intensity: effect ? (intensities[effect] ?? DEFAULT_INTENSITY) : DEFAULT_INTENSITY };
}
