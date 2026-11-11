// Refreshes example widgets in a state dir from the copies shipped with Hatch. Opening an example copies it once and
// never touches it again, so an instance keeps the old code after an upgrade until this runs. The widget's data/ folder
// (downloaded images, ...) is never touched. A file that was changed locally is saved as <file>.bak before it is replaced.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from './state.js';

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

// ---- "has the shipped copy changed since this instance copied it?" ----
// When an example is copied into a state dir (or refreshed), a hash of the shipped files is recorded in shipped-widgets.json.
// Later the recorded hash, the shipped hash and the local hash tell three cases apart without guessing:
//   shipped == recorded                       nothing new upstream: no warning, whatever was edited locally
//   shipped != recorded, local == recorded    untouched copy, newer version available: warn
//   shipped != recorded, local differs        edited on purpose and upstream moved: warn (update-widgets keeps edits as .bak)
// An instance with no record (copied before this existed) is compared by content: equal means current (and is recorded);
// different is "stale" only when the files look unedited (all written within seconds of each other, as one copy does),
// otherwise it is unknown and nothing is said.
const RECORD = 'shipped-widgets.json';
const hashFiles = (dir) => {
  if (!fs.existsSync(dir)) return null;
  const h = crypto.createHash('sha256');
  for (const f of walk(dir).filter((x) => x.split(path.sep)[0] !== 'data' && !x.endsWith('.bak')).sort()) h.update(`${f}\0`).update(fs.readFileSync(path.join(dir, f))).update('\0');
  return h.digest('hex');
};
export const shippedHash = (name) => hashFiles(path.join(EXAMPLES, name));
export const localHash = (stateDir, name) => hashFiles(path.join(stateDir, 'widgets', name));
function readRecord(stateDir) { try { const r = JSON.parse(fs.readFileSync(path.join(stateDir, RECORD), 'utf8')); return r && typeof r === 'object' && !Array.isArray(r) ? r : {}; } catch { return {}; } }
export function recordShipped(stateDir, name) {
  const h = shippedHash(name); if (!h) return;
  const r = readRecord(stateDir); if (r[name] === h) return;
  try { atomicWrite(path.join(stateDir, RECORD), `${JSON.stringify({ ...r, [name]: h }, null, 2)}\n`); } catch { /* read-only state: the warning just stays unknown */ }
}
const looksUnedited = (dir) => {
  const t = walk(dir).filter((x) => x.split(path.sep)[0] !== 'data' && !x.endsWith('.bak')).map((x) => fs.statSync(path.join(dir, x)).mtimeMs);
  return t.length >= 2 && Math.max(...t) - Math.min(...t) < 5000;
};
/** 'current', 'stale' (a newer shipped version exists) or 'unknown' (not installed here, or cannot tell). */
export function widgetStatus(stateDir, name) {
  const shipped = shippedHash(name); const local = localHash(stateDir, name);
  if (!shipped || !local) return 'unknown';
  if (local === shipped) { recordShipped(stateDir, name); return 'current'; }
  const rec = readRecord(stateDir)[name];
  if (rec) return rec === shipped ? 'current' : 'stale';
  return looksUnedited(path.join(stateDir, 'widgets', name)) ? 'stale' : 'unknown';
}
export const staleMessage = (name) => `The shipped ${name} widget changed since this instance copied it. Refresh it with: hatch-server update-widgets ${name}`;

// ---- per-project git widgets ----
// `hatch widget open git` makes one copy per project (git-<folder>) whose widget.json has the project's directory and title
// baked in, so a whole-folder hash never matches the shipped example. Those copies carry from:"git"; older ones are
// recognised by their name and dir. Refreshing replaces the code files and rebuilds widget.json from the shipped one.
const GIT = 'git';
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
/** widget.json for a git widget of the project at `dir`: the shipped one with {{cwd}} pinned (shell-quoted) to it. */
export function gitProjectMeta(shippedMeta, dir, title) {
  const quoted = `'${dir.replace(/'/g, `'\\''`)}'`;
  return { ...shippedMeta, title, dir, from: GIT, sources: (shippedMeta.sources || []).map((src) => ({ ...src, cmd: src.cmd.replaceAll('{{cwd}}', () => quoted) })) };
}
export function projectGitCopies(stateDir) {
  const root = path.join(stateDir, 'widgets'); if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).filter((n) => {
    const m = readJson(path.join(root, n, 'widget.json'));
    return m && typeof m.dir === 'string' && (m.from === GIT || (n.startsWith('git-') && !m.from));
  });
}
const sameFiles = (a, b) => walk(b).filter((f) => f !== 'widget.json' && f.split(path.sep)[0] !== 'data').every((f) => fs.existsSync(path.join(a, f)) && fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))));
/** Project git copies whose code differs from the shipped git widget. */
export const staleProjectCopies = (stateDir) => projectGitCopies(stateDir).filter((n) => !sameFiles(path.join(stateDir, 'widgets', n), path.join(EXAMPLES, GIT)));
function refreshProjectCopy(stateDir, name) {
  const src = path.join(EXAMPLES, GIT); const dest = path.join(stateDir, 'widgets', name); const files = []; const backups = [];
  for (const f of walk(src)) {
    if (f === 'widget.json' || f.split(path.sep)[0] === 'data') continue;
    const to = path.join(dest, f); const next = fs.readFileSync(path.join(src, f));
    if (fs.existsSync(to)) { const cur = fs.readFileSync(to); if (cur.equals(next)) continue; fs.writeFileSync(`${to}.bak`, cur); backups.push(f); }
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, next); files.push(f);
  }
  const metaFile = path.join(dest, 'widget.json'); const old = readJson(metaFile) || {};
  const next = gitProjectMeta(readJson(path.join(src, 'widget.json')), old.dir, old.title || `Git: ${path.basename(old.dir)}`);
  for (const k of ['w', 'h', 'placement']) if (old[k] !== undefined) next[k] = old[k]; // window size the user chose stays
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (!fs.existsSync(metaFile) || fs.readFileSync(metaFile, 'utf8') !== text) { if (fs.existsSync(metaFile)) fs.copyFileSync(metaFile, `${metaFile}.bak`); atomicWrite(metaFile, text); files.push('widget.json'); }
  return { name, files, backups };
}

/** names: widget names, or null for all. Returns { updated: [{name, files, backups}], unchanged: [name], missing: [name] }. */
export function updateWidgets(stateDir, names = null) {
  const shipped = shippedWidgets();
  const copies = projectGitCopies(stateDir);
  const unknown = (names || []).filter((n) => !shipped.includes(n) && !copies.includes(n));
  if (unknown.length) throw new Error(`no example widget ${unknown.join(', ')}; available: ${shipped.join(', ')}`);
  const res = { updated: [], unchanged: [], missing: [] };
  for (const name of names || shipped) {
    if (copies.includes(name)) continue; // handled below
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
    recordShipped(stateDir, name);
    (files.length ? res.updated.push({ name, files, backups }) : res.unchanged.push(name));
  }
  // Per-project git copies: named directly, or refreshed along with "git" and --all
  for (const name of copies.filter((n) => !names || names.includes(n) || names.includes(GIT))) {
    const u = refreshProjectCopy(stateDir, name);
    (u.files.length ? res.updated.push(u) : res.unchanged.push(name));
  }
  return res;
}
