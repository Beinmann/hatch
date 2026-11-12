// `hatch migrate`: imports a project's own state dir (the old per-project `.hatch`) into the per-user instance as a workspace.
// It merges FILES in the target state dir, whether or not a server is running there: files are the source of truth and a
// running server picks the changes up by itself (it watches the state dir). Nothing is written to the source, nothing is
// stopped or restarted, and nothing already in the target is overwritten: differences are reported as conflicts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, ensureLayout, layout } from './state.js';
import * as ws from './workspaces.js';
import { DEFAULT_PORT } from './free-port.js';
import { defaultStateDir } from './find.js';

export class MigrateError extends Error {}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
const isStateDir = (d) => fs.existsSync(path.join(d, 'config.json')) || fs.existsSync(path.join(d, 'panels'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** The source state dir: DIR/.hatch, or DIR itself when it is a state dir; no DIR = the nearest `.hatch` walking up from cwd (this command only). */
export function findSource(arg, cwd = process.cwd()) {
  if (arg) {
    const d = path.resolve(cwd, arg);
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw new MigrateError(`${d} is not a folder; pass a project folder or its .hatch dir`);
    if (isStateDir(path.join(d, '.hatch'))) return { srcDir: path.join(d, '.hatch'), project: path.basename(d) };
    if (isStateDir(d)) return { srcDir: d, project: path.basename(path.dirname(d)) };
    throw new MigrateError(`no Hatch state dir in ${d} (looked for ${path.join(d, '.hatch')} and ${d} itself, expecting config.json or panels/)`);
  }
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (isStateDir(path.join(dir, '.hatch'))) return { srcDir: path.join(dir, '.hatch'), project: path.basename(dir) };
    if (path.dirname(dir) === dir) break;
  }
  throw new MigrateError('no .hatch found from here upwards; pass the project folder or its .hatch dir: hatch migrate DIR');
}

/** A workspace name from a folder name: letters, digits, - and _ (at most 32). */
export const workspaceNameFor = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 32);

/** Where the old instance's terminals started: its daemon's --cwd/working dir, else the project folder. */
function sourceCwd(srcDir) {
  const d = readJson(path.join(srcDir, 'daemon.json'));
  let c = null;
  if (d && Array.isArray(d.args)) { const i = d.args.findIndex((a) => a === '--cwd'); if (i >= 0 && d.args[i + 1]) c = d.args[i + 1]; else { const e = d.args.find((a) => a.startsWith('--cwd=')); if (e) c = e.slice(6); } }
  if (!c && d && typeof d.cwd === 'string') c = d.cwd;
  const project = path.dirname(path.resolve(srcDir));
  return c && fs.existsSync(c) ? path.resolve(c) : project;
}

// Merging helpers. Each returns report lines and records conflicts; none overwrites.
function mergeList(src, dst, label, { dry, report, key = (x) => x?.name }) {
  const a = readJson(src); if (a === undefined) return;
  if (!Array.isArray(a)) { report.conflicts.push(`${label}: not a JSON array in the source; skipped`); return; }
  let b = readJson(dst); if (b === undefined) b = [];
  if (!Array.isArray(b)) { report.conflicts.push(`${label}: the target file is not a JSON array; left alone`); return; }
  const added = [];
  for (const item of a) {
    const k = key(item); const have = k === undefined ? b.find((x) => same(x, item)) : b.find((x) => key(x) === k);
    if (!have) { b.push(item); added.push(k ?? JSON.stringify(item).slice(0, 40)); }
    else if (!same(have, item)) report.conflicts.push(`${label} "${k}" exists in both with different content; kept the existing one`);
  }
  if (added.length) { report.steps.push(`${label}: add ${added.join(', ')}`); if (!dry) atomicWrite(dst, `${JSON.stringify(b, null, 2)}\n`); }
}

function copyOrConflict(src, dst, label, { dry, report, name, aside = false }) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dst)) { report.steps.push(`${label}: copy`); if (!dry) fs.copyFileSync(src, dst); return; }
  if (hash(src) === hash(dst)) return;
  if (aside) {
    const alt = `${dst}.${name}.migrated`;
    report.conflicts.push(`${label} differs; saved the source's as ${path.basename(alt)} (not loaded: merge by hand)`);
    if (!dry && !fs.existsSync(alt)) fs.copyFileSync(src, alt);
  } else report.conflicts.push(`${label} differs; kept the existing one`);
}

function mergeObject(src, dst, label, { dry, report, skip = [] }) {
  const a = readJson(src); if (!a || typeof a !== 'object' || Array.isArray(a)) return;
  let b = readJson(dst); if (b === undefined) b = {};
  const added = [];
  for (const [k, v] of Object.entries(a)) {
    if (skip.includes(k)) continue;
    if (!(k in b)) { b[k] = v; added.push(k); }
    else if (!same(b[k], v)) report.conflicts.push(`${label}: "${k}" is ${JSON.stringify(b[k])} here and ${JSON.stringify(v)} in the source; kept the existing value`);
  }
  if (added.length) { report.steps.push(`${label}: add ${added.join(', ')}`); if (!dry) atomicWrite(dst, `${JSON.stringify(b, null, 2)}\n`, { mode: 0o600 }); }
}

/**
 * Plans (dry) or performs the migration. Returns { source, target, name, workspaces: [..], steps: [..], conflicts: [..], notes: [..] }.
 * Throws MigrateError for things that must be decided by the user (name clash, bad source).
 */
export function migrateProject({ srcDir, target, name, dry = false }) {
  srcDir = path.resolve(srcDir); target = path.resolve(target);
  if (srcDir === target) throw new MigrateError('the source is the per-user instance itself; nothing to migrate. Pass another project\'s .hatch');
  if (!WS_NAME(name)) throw new MigrateError(`"${name}" is not a usable workspace name (1-32 letters, digits, - and _); pass --name NAME`);
  const report = { source: srcDir, target, name, workspaces: [], steps: [], conflicts: [], notes: [] };
  const cwd = sourceCwd(srcDir);
  // the source's own workspaces (main + registry) each become a workspace of the target: <name> for main, <name>-<ws> for the rest
  const srcPanels = []; for (const f of fs.existsSync(path.join(srcDir, 'panels')) ? fs.readdirSync(path.join(srcDir, 'panels')) : []) { const d = f.endsWith('.json') ? readJson(path.join(srcDir, 'panels', f)) : undefined; if (d && typeof d === 'object') srcPanels.push(d); }
  const srcList = ws.listWorkspaces(srcDir, srcPanels).list;
  const groups = srcList.map((w) => ({ src: w, target: w.name === ws.MAIN ? name : `${name}-${w.name}`.slice(0, 32) }));
  const targetPanels = []; for (const f of fs.existsSync(path.join(target, 'panels')) ? fs.readdirSync(path.join(target, 'panels')) : []) { const d = f.endsWith('.json') ? readJson(path.join(target, 'panels', f)) : undefined; if (d) targetPanels.push(d); }
  const existing = ws.listWorkspaces(target, targetPanels).list.map((w) => w.name.toLowerCase());
  const clash = groups.filter((g) => existing.includes(g.target.toLowerCase()) || g.target.toLowerCase() === ws.MAIN);
  if (clash.length) throw new MigrateError(`a workspace named ${clash.map((g) => g.target).join(', ')} already exists in ${target} (names are not case sensitive); nothing was changed. Pick another name: hatch migrate --name NAME`);
  if (new Set(groups.map((g) => g.target.toLowerCase())).size !== groups.length) throw new MigrateError(`workspace names derived from ${srcDir} collide; pass --name NAME`);

  if (!dry) { ensureLayout(target); createConfigIfMissing(target); ws.migrate(target); }
  else if (!fs.existsSync(target)) report.steps.push(`create ${target} (state dir with a new token; the server finishes it on first start)`);

  const ctx = {};
  for (const g of groups) {
    const dirOf = ws.workspaceDir(srcDir, g.src);
    const r = ws.importState(target, srcDir, g.target, { select: (p) => (p.ws && p.ws !== ws.MAIN ? p.ws : ws.MAIN) === g.src.name, cwd, bgFrom: dirOf, prefixClash: true, ctx, dry });
    report.workspaces.push({ name: g.target, windows: r.windows });
    report.steps.push(`workspace ${g.target}${r.created ? ' (new)' : ''}: ${r.windows} window${r.windows === 1 ? '' : 's'}, terminals start in ${cwd}`);
    for (const l of r.plan) report.steps.push(`  ${l}`);
    for (const l of r.skipped) report.notes.push(l);
  }

  // everything that is not a window; the target is never overwritten
  const o = { dry, report };
  const widgetsFrom = path.join(srcDir, 'widgets');
  for (const n of fs.existsSync(widgetsFrom) ? fs.readdirSync(widgetsFrom) : []) {
    const from = path.join(widgetsFrom, n); const to = path.join(target, 'widgets', n);
    if (!fs.statSync(from).isDirectory()) continue;
    if (!fs.existsSync(to)) { report.steps.push(`widget ${n}: copy`); if (!dry) fs.cpSync(from, to, { recursive: true }); }
    else if (!sameTree(from, to)) report.conflicts.push(`widget ${n} differs from the one already here; kept the existing one`);
  }
  mergeList(path.join(srcDir, 'commands.json'), path.join(target, 'commands.json'), 'commands.json (saved commands and prompts)', o);
  mergeList(path.join(srcDir, 'schedules.json'), path.join(target, 'schedules.json'), 'schedules.json', o);
  mergeList(path.join(srcDir, 'bookmarks.json'), path.join(target, 'bookmarks.json'), 'bookmarks.json', o);
  mergeList(path.join(srcDir, 'watches.json'), path.join(target, 'watches.json'), 'watches.json', o);
  copyOrConflict(path.join(srcDir, 'custom.css'), path.join(target, 'custom.css'), 'custom.css', { ...o, name, aside: true });
  copyOrConflict(path.join(srcDir, 'custom.js'), path.join(target, 'custom.js'), 'custom.js', { ...o, name, aside: true });
  for (const f of ['fx.json', 'transparency.json']) copyOrConflict(path.join(srcDir, f), path.join(target, f), f, o);
  mergeObject(path.join(srcDir, 'sizes.json'), path.join(target, 'sizes.json'), 'sizes.json', o);
  // settings: instance identity (token, port, host, session) belongs to the target; the rest is merged key by key
  const cfgSrc = readJson(path.join(srcDir, 'config.json')); const cfgDst = path.join(target, 'config.json');
  if (cfgSrc && typeof cfgSrc === 'object') {
    const hosts = Array.isArray(cfgSrc.allowedHosts) ? cfgSrc.allowedHosts.filter((h) => typeof h === 'string') : [];
    const dst = readJson(cfgDst) || {}; const have = Array.isArray(dst.allowedHosts) ? dst.allowedHosts : []; const addHosts = hosts.filter((h) => !have.includes(h));
    if (addHosts.length) { report.steps.push(`config.json: allowedHosts add ${addHosts.join(', ')}`); if (!dry) { dst.allowedHosts = [...have, ...addHosts]; atomicWrite(cfgDst, `${JSON.stringify(dst, null, 2)}\n`, { mode: 0o600 }); } }
    mergeObject(path.join(srcDir, 'config.json'), cfgDst, 'config.json settings', { ...o, skip: ['token', 'port', 'host', 'session', 'allowedHosts'] });
  }
  const hostsFile = path.join(srcDir, 'allowed-hosts');
  if (fs.existsSync(hostsFile)) {
    const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean) : []);
    const dstFile = path.join(target, 'allowed-hosts'); const have = lines(dstFile); const add = lines(hostsFile).filter((h) => !have.includes(h));
    if (add.length) { report.steps.push(`allowed-hosts: add ${add.join(', ')}`); if (!dry) fs.writeFileSync(dstFile, `${[...have, ...add].join('\n')}\n`); }
  }
  report.notes.push('not imported: progress plans and diagrams, run history, trash, tokens, ports (the target keeps its own), and running terminal sessions (terminals start fresh shells; old tmux sessions are left alone)');
  return report;
}

const WS_NAME = (n) => typeof n === 'string' && ws.WS_RE.test(n);

function createConfigIfMissing(target) {
  const file = layout(target).config;
  if (fs.existsSync(file)) return;
  // the same shape the server writes on first start, so the dir is a valid state dir right away
  atomicWrite(file, `${JSON.stringify({ token: crypto.randomBytes(16).toString('hex'), port: DEFAULT_PORT, host: '0.0.0.0' }, null, 2)}\n`, { mode: 0o600 });
}

function sameTree(a, b) {
  const list = (d) => (fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(path.join(d, e.name)).map((x) => path.join(e.name, x)) : [e.name])).sort());
  try {
    const x = list(a); const y = list(b);
    return same(x, y) && x.every((f) => hash(path.join(a, f)) === hash(path.join(b, f)));
  } catch { return false; }
}

/** The manual steps, printed last; migrate never stops or starts anything itself. */
export function nextSteps({ target, source }) {
  const state = target === defaultStateDir() ? '' : ` --state ${target}`;
  return [
    'Next steps (migrate did not stop or start anything):',
    `  1. Stop the old instance (Ctrl+C where it runs, or \`hatch-server stop --state ${source}\`; the source is untouched).`,
    `  2. Start the per-user instance:  hatch-server start${state}`,
    '  3. Open the URL it prints (new token; one URL for everything) and switch to the new workspace (palette: "workspace: switch").',
    '  If the per-user instance already runs, the page shows the new workspace by itself; terminals in it start fresh shells.',
    '  To go back: stop the per-user instance and run `hatch-server start --state .hatch --yes` in the project folder.',
  ];
}
