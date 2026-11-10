// Refreshes example widgets in a state dir from the copies shipped with Hatch. Opening an example copies it once and
// never touches it again, so an instance keeps the old code after an upgrade until this runs. The widget's data/ folder
// (downloaded images, ...) is never touched. A file that was changed locally is saved as <file>.bak before it is replaced.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXAMPLES = fileURLToPath(new URL('../examples/widgets/', import.meta.url));

export function shippedWidgets() {
  return fs.readdirSync(EXAMPLES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(dir, r)); else if (e.isFile()) out.push(r);
  }
  return out;
}

/** names: widget names, or null for all. Returns { updated: [{name, files, backups}], unchanged: [name], missing: [name] }. */
export function updateWidgets(stateDir, names = null) {
  const shipped = shippedWidgets();
  const unknown = (names || []).filter((n) => !shipped.includes(n));
  if (unknown.length) throw new Error(`no example widget ${unknown.join(', ')}; available: ${shipped.join(', ')}`);
  const res = { updated: [], unchanged: [], missing: [] };
  for (const name of names || shipped) {
    const dest = path.join(stateDir, 'widgets', name);
    if (!fs.existsSync(dest)) { res.missing.push(name); continue; } // never opened in this instance: nothing to update
    const src = path.join(EXAMPLES, name); const files = []; const backups = [];
    for (const f of walk(src)) {
      if (f.split(path.sep)[0] === 'data') continue;
      const from = path.join(src, f); const to = path.join(dest, f);
      const next = fs.readFileSync(from);
      if (fs.existsSync(to)) {
        const cur = fs.readFileSync(to);
        if (cur.equals(next)) continue;
        fs.writeFileSync(`${to}.bak`, cur); backups.push(f);
      }
      fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, next); files.push(f);
    }
    (files.length ? res.updated.push({ name, files, backups }) : res.unchanged.push(name));
  }
  return res;
}
