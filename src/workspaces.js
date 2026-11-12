// Workspaces: named sets of windows (each with its own main terminal and background) inside one Hatch instance.
// The registry is workspaces.json in the state dir: { "version": 1, "workspaces": [{ "name": "main", "id": "main" }, ...] }.
// A window belongs to a workspace through its `ws` field (absent = main), so the panel files stay the source of truth for
// layout; the registry only adds what a window list cannot hold: empty workspaces, order, and a stable id per workspace.
// A workspace may carry `cwd`: the directory its terminals start in (set by `hatch migrate`).
// The id (not the name) names the workspace's tmux session and background folder, so renaming never moves anything.
// `main` keeps using the state dir itself for its background, which is what makes the migration a wrap, not a copy.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite } from './state.js';

export const WS_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
export const MAIN = 'main';
export const REGISTRY = 'workspaces.json';
export const BACKUP_DIR = 'backup-pre-workspaces';
export class WorkspaceError extends Error { constructor(message, status = 400) { super(message); this.name = 'WorkspaceError'; this.status = status; } }

const BG_FILES = /^background\.(png|jpg|gif|webp|json)$/;

/** Reads the registry. Returns { list: [{name,id}], problem? }; main is always first and always present. */
export function readRegistry(dir) {
  let list = []; let problem = null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, REGISTRY), 'utf8'));
    const raw = Array.isArray(data?.workspaces) ? data.workspaces : (problem = `${REGISTRY} needs a "workspaces" array`, []);
    for (const w of raw) {
      const name = typeof w === 'string' ? w : w?.name;
      if (typeof name !== 'string' || !WS_RE.test(name)) { problem = `${REGISTRY}: skipped an entry with an unusable name; names are letters, digits, - and _`; continue; }
      if (list.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
      const id = typeof w?.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(w.id) ? w.id : name;
      list.push({ name, id, ...(typeof w?.cwd === 'string' && w.cwd && { cwd: w.cwd }) });
    }
  } catch (e) { if (e.code !== 'ENOENT') problem = `${REGISTRY} is not valid JSON (${e.message}); fix it or delete it (a window list is rebuilt from the panels)`; }
  list = [{ name: MAIN, id: MAIN }, ...list.filter((w) => w.name !== MAIN)];
  return { list, ...(problem && { problem }) };
}

export function writeRegistry(dir, list) {
  atomicWrite(path.join(dir, REGISTRY), `${JSON.stringify({ version: 1, workspaces: list.map(({ name, id, cwd }) => ({ name, id, ...(cwd && { cwd }) })) }, null, 2)}\n`);
}

/** Registry plus any workspace name only seen on a window (hand edit, `--ws`): { name, id } in registry order, extras sorted after. */
export function listWorkspaces(dir, panels = []) {
  const { list, problem } = readRegistry(dir);
  const seen = new Set(list.map((w) => w.name));
  const extras = [...new Set(panels.map((p) => p.ws).filter((n) => n && !seen.has(n)))].sort();
  return { list: [...list, ...extras.map((name) => ({ name, id: name }))], ...(problem && { problem }) };
}

/** The folder holding a workspace's own files (background): the state dir for main, workspaces/<id> otherwise. */
export const workspaceDir = (dir, w) => (w.name === MAIN ? dir : path.join(dir, 'workspaces', w.id));

export function findWorkspace(dir, name, panels = []) {
  const w = listWorkspaces(dir, panels).list.find((x) => x.name === name);
  if (!w) throw new WorkspaceError(`no workspace named ${name}; list them with \`hatch workspace list\``, 404);
  return w;
}

/** The tmux/pty name of a workspace's main terminal. `main` uses the original terminal, so nothing changes for it. */
export const terminalName = (w) => `ws-${w.id}`;

function checkName(list, name) {
  if (typeof name !== 'string' || !WS_RE.test(name)) throw new WorkspaceError('workspace names are 1-32 letters, digits, - and _, starting with a letter or digit');
  if (list.some((w) => w.name.toLowerCase() === name.toLowerCase())) throw new WorkspaceError(`a workspace named ${name} already exists (names are not case sensitive); pick another name`, 409);
}

export function createWorkspace(dir, name, panels = []) {
  const { list } = listWorkspaces(dir, panels);
  checkName(list, name);
  const w = { name, id: crypto.randomBytes(4).toString('hex') };
  writeRegistry(dir, [...list, w]);
  return w;
}

/** Renames in the registry only; the caller moves the windows (their ws field). */
export function renameWorkspace(dir, from, to, panels = []) {
  const { list } = listWorkspaces(dir, panels);
  if (from === MAIN) throw new WorkspaceError('main cannot be renamed; create another workspace instead');
  const cur = list.find((w) => w.name === from);
  if (!cur) throw new WorkspaceError(`no workspace named ${from}`, 404);
  checkName(list.filter((w) => w.name !== from), to);
  writeRegistry(dir, list.map((w) => (w.name === from ? { ...w, name: to } : w)));
  return { ...cur, name: to };
}

/** Drops the registry entry and the workspace folder. The caller closes the windows and terminals first. */
export function removeWorkspace(dir, name, panels = []) {
  if (name === MAIN) throw new WorkspaceError('main cannot be closed; it is the default workspace');
  const { list } = listWorkspaces(dir, panels);
  const cur = list.find((w) => w.name === name);
  if (!cur) throw new WorkspaceError(`no workspace named ${name}`, 404);
  writeRegistry(dir, list.filter((w) => w.name !== name));
  fs.rmSync(path.join(dir, 'workspaces', cur.id), { recursive: true, force: true });
  return cur;
}

const copyBackground = (fromDir, toDir) => {
  let any = false;
  for (const f of fs.existsSync(fromDir) ? fs.readdirSync(fromDir) : []) {
    if (!BG_FILES.test(f)) continue;
    fs.mkdirSync(toDir, { recursive: true }); fs.copyFileSync(path.join(fromDir, f), path.join(toDir, f)); any = true;
  }
  return any;
};

function readPanelFiles(dir) {
  const out = [];
  let files = []; try { files = fs.readdirSync(path.join(dir, 'panels')); } catch { return out; }
  for (const f of files) { if (!f.endsWith('.json')) continue; try { out.push({ file: f, data: JSON.parse(fs.readFileSync(path.join(dir, 'panels', f), 'utf8')) }); } catch { /* a broken panel file is left alone */ } }
  return out;
}

/**
 * First start after workspaces were introduced: the existing layout, windows and background become workspace `main`
 * (they already live in the state dir, so nothing is moved or recreated). Windows that already carried a workspace name
 * (the older virtual desktops) keep it and get a registry entry, with a copy of main's background so they look as before.
 * What the migration relies on is copied to backup-pre-workspaces/ first, and kept until the user deletes it.
 * The registry is written last, so a crash in between just repeats the (idempotent) migration.
 * Returns { migrated, backup?, workspaces }.
 */
export function migrate(dir) {
  const reg = path.join(dir, REGISTRY);
  if (fs.existsSync(reg)) return { migrated: false, workspaces: readRegistry(dir).list.map((w) => w.name) };
  const panelFiles = readPanelFiles(dir);
  const extras = [...new Set(panelFiles.map((p) => p.data?.ws).filter((n) => typeof n === 'string' && WS_RE.test(n) && n !== MAIN))].sort();
  const topFiles = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !/\.(lock|pid|tmp)$/.test(e.name) && e.name !== '.gitignore') : [];
  const hasState = panelFiles.length > 0 || topFiles.some((e) => BG_FILES.test(e.name));
  let backup;
  const bdir = path.join(dir, BACKUP_DIR);
  if (hasState && !fs.existsSync(bdir)) {
    fs.mkdirSync(bdir, { recursive: true });
    for (const e of topFiles) fs.copyFileSync(path.join(dir, e.name), path.join(bdir, e.name));
    for (const sub of ['panels', 'progress']) if (fs.existsSync(path.join(dir, sub))) fs.cpSync(path.join(dir, sub), path.join(bdir, sub), { recursive: true });
    fs.writeFileSync(path.join(bdir, 'README.txt'), `State before workspaces were introduced (panels, progress and the top-level files). Safe to delete once the workspaces look right.\n`);
  }
  if (hasState) backup = bdir;
  const list = [{ name: MAIN, id: MAIN }];
  for (const name of extras) { list.push({ name, id: name }); copyBackground(dir, path.join(dir, 'workspaces', name)); }
  writeRegistry(dir, list);
  return { migrated: true, ...(backup && { backup }), workspaces: list.map((w) => w.name) };
}

/**
 * Folds another instance's state dir into a workspace: its windows (new ids; terminal names that clash get a suffix),
 * its background and the widgets and uploads they use are copied. Running terminals cannot move between instances, so a
 * terminal window starts a fresh shell. Progress plans, saved commands and settings are not imported (`hatch migrate`
 * does those; see migrate.js).
 * Options (used by migrate): `select(panel)` picks which windows go to this workspace, `cwd` becomes the workspace's
 * terminal start directory (and a terminal window's own props.cwd), `bgFrom` is where the background is read from,
 * `prefixClash` renames a clashing terminal `<workspace>-<name>` instead of `<name>-2`, `ctx` carries the id counter and
 * the taken terminal names across several calls, `dry` changes nothing and only fills `plan`.
 * Returns { workspace, created, windows, skipped: [..], plan: [..] }.
 */
export function importState(dir, srcDir, name, { select = null, cwd = null, bgFrom = null, prefixClash = false, ctx = {}, dry = false } = {}) {
  srcDir = path.resolve(srcDir);
  if (!fs.existsSync(path.join(srcDir, 'panels')) && !fs.existsSync(path.join(srcDir, 'config.json'))) throw new WorkspaceError(`${srcDir} does not look like a Hatch state dir (no panels/ or config.json); pass the .hatch folder of the instance`);
  if (path.resolve(dir) === srcDir) throw new WorkspaceError('that is this instance\'s own state dir; pass another instance\'s');
  const mine = readPanelFiles(dir).map((p) => p.data);
  let { list } = listWorkspaces(dir, mine);
  let w = list.find((x) => x.name === name); let created = false;
  if (!w) { created = true; w = dry ? { name, id: '(new)' } : createWorkspace(dir, name, mine); }
  if (cwd && !dry && w.name !== MAIN) writeRegistry(dir, listWorkspaces(dir, readPanelFiles(dir).map((p) => p.data)).list.map((x) => (x.name === w.name ? { ...x, cwd } : x)));
  const taken = ctx.taken ||= new Set(mine.filter((p) => p?.type === 'terminal').map((p) => p.props?.name));
  if (ctx.max === undefined) { ctx.max = 0; for (const f of fs.existsSync(path.join(dir, 'panels')) ? fs.readdirSync(path.join(dir, 'panels')) : []) { const m = /^p(\d+)\.json$/.exec(f); if (m) ctx.max = Math.max(ctx.max, Number(m[1])); } }
  const skipped = []; const plan = []; let windows = 0;
  if (!dry) fs.mkdirSync(path.join(dir, 'panels'), { recursive: true });
  for (const { file, data } of readPanelFiles(srcDir)) {
    if (!data || typeof data !== 'object') continue;
    if (select && !select(data)) continue;
    const p = { ...data };
    if (p.type === 'progress') { skipped.push(`${file}: progress windows are not imported`); continue; }
    let note = '';
    if (p.type === 'terminal') {
      const orig = String(p.props?.name || 'shell'); let n = orig; let i = 2;
      if (prefixClash && taken.has(n)) n = `${w.name}-${orig}`.slice(0, 64);
      while (taken.has(n)) n = `${prefixClash ? `${w.name}-${orig}` : orig}-${i++}`.slice(0, 64);
      taken.add(n); p.props = { ...p.props, name: n, ...(cwd && !p.props?.cwd && { cwd }) };
      if (n !== orig) note = ` (terminal renamed ${orig} -> ${n}: that name is taken)`;
    }
    if (p.type === 'widget' && p.props?.name) {
      const from = path.join(srcDir, 'widgets', p.props.name); const to = path.join(dir, 'widgets', p.props.name);
      if (fs.existsSync(from) && !fs.existsSync(to)) { if (!dry) fs.cpSync(from, to, { recursive: true }); }
      else if (fs.existsSync(to) && fs.existsSync(from)) skipped.push(`widget ${p.props.name} already exists here; kept this instance's copy`);
    }
    if (p.type === 'image' && typeof p.props?.src === 'string' && p.props.src.startsWith('/files/uploads/')) {
      const f = path.basename(p.props.src); const from = path.join(srcDir, 'uploads', f); const to = path.join(dir, 'uploads', f);
      if (fs.existsSync(from) && !fs.existsSync(to) && !dry) { fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true }); fs.copyFileSync(from, to); }
    }
    ctx.max += 1; const id = `p${ctx.max}`; delete p.id; delete p.activation;
    if (w.name === MAIN) delete p.ws; else p.ws = w.name;
    if (!dry) atomicWrite(path.join(dir, 'panels', `${id}.json`), `${JSON.stringify({ ...p, id }, null, 2)}\n`);
    plan.push(`window ${data.id || file} (${p.type}${p.title ? ` "${p.title}"` : ''}) -> ${id} in ${w.name}${note}`);
    windows += 1;
  }
  const bgDir = workspaceDir(dir, w); const from = bgFrom || srcDir;
  const hadBg = fs.existsSync(bgDir) && fs.readdirSync(bgDir).some((f) => /^background\.(png|jpg|gif|webp)$/.test(f));
  const srcHasBg = fs.existsSync(from) && fs.readdirSync(from).some((f) => /^background\.(png|jpg|gif|webp)$/.test(f));
  if (hadBg) skipped.push('background: the workspace already has one; kept it');
  else if (srcHasBg) { if (!dry) copyBackground(from, bgDir); plan.push(`background of ${path.basename(path.dirname(path.resolve(from)))}/${path.basename(from)} -> workspace ${w.name}`); }
  return { workspace: w.name, created, windows, skipped, plan };
}
