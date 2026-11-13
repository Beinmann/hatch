// Per-directory widget layout: `hatch widget save [DIR]` writes .hatch-widgets.json, `hatch widget restore [DIR]` reads it.
// Layout only (name, position, size, minimized, placement); never widget content or state. Pure helpers, so the CLI stays thin.
import fs from 'node:fs';
import path from 'node:path';
import { NAME_RE } from './state.js';

export const LAYOUT_FILE = '.hatch-widgets.json';
const PLACEMENTS = ['float', 'dock'];
const num = (v) => typeof v === 'number' && Number.isFinite(v);

/** The widget windows of one workspace as layout entries. `ws` is the workspace name; panels without one belong to main. */
export function entriesFromPanels(panels, ws = 'main') {
  return panels
    .filter((p) => p.type === 'widget' && typeof p.props?.name === 'string' && (p.ws || 'main') === ws)
    .map((p) => {
      const e = { name: p.props.name, placement: p.placement === 'dock' ? 'dock' : 'float' };
      for (const k of ['x', 'y', 'w', 'h']) if (num(p[k])) e[k] = Math.round(p[k]);
      e.minimized = p.minimized === true;
      return e;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function writeLayout(dir, entries) {
  const file = path.join(dir, LAYOUT_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, widgets: entries }, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

/** Reads DIR/.hatch-widgets.json. Returns { entries, warnings } or { error } (missing, unreadable or not a layout file). Never throws. */
export function readLayout(dir) {
  const file = path.join(dir, LAYOUT_FILE);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { error: e.code === 'ENOENT' ? `no ${LAYOUT_FILE} in ${dir}; create one with: hatch widget save` : `cannot read ${file}: ${e.message}` };
  }
  let data;
  try { data = JSON.parse(raw); } catch (e) { return { error: `${file} is not valid JSON (${e.message}); fix it or run hatch widget save again to overwrite it` }; }
  if (!data || typeof data !== 'object' || !Array.isArray(data.widgets)) return { error: `${file} has no "widgets" list; fix it or run hatch widget save again to overwrite it` };
  const entries = []; const warnings = [];
  data.widgets.forEach((w, i) => {
    if (!w || typeof w !== 'object' || typeof w.name !== 'string' || !NAME_RE.test(w.name)) { warnings.push(`entry ${i + 1} skipped: it needs a "name" of letters, digits, - and _`); return; }
    const e = { name: w.name, minimized: w.minimized === true };
    if (PLACEMENTS.includes(w.placement)) e.placement = w.placement;
    else if (w.placement !== undefined) warnings.push(`${w.name}: placement ${JSON.stringify(w.placement)} ignored (use float or dock)`);
    for (const k of ['x', 'y', 'w', 'h']) {
      if (num(w[k])) e[k] = w[k];
      else if (w[k] !== undefined) warnings.push(`${w.name}: ${k} ${JSON.stringify(w[k])} ignored (not a number)`);
    }
    entries.push(e);
  });
  return { entries, warnings };
}
