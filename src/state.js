// The state dir is the single write model: panels, widgets, progress and uploads are plain files. The CLI and the
// HTTP API only write files; this module watches them and turns changes into events, so editing by hand works too.
// Hand-edited or malformed files give a warning (never a crash) and the last good state stays in place.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { findBackground, readMode } from './background.js';
import { listWorkspaces, workspaceDir } from './workspaces.js';
import { readFx } from './fx.js';
import { readTransparency, DEFAULT_TRANSPARENCY } from './transparency.js';
import { sizeKey, sizeFor, readSizes, rememberSize } from './sizes.js';
import { createPlans } from './plans.js';
import { normalizeSteps, STEP_STATUS, findStep, unusedStepId } from './progress.js';
import { normalizeTarget, checkConversion, checklistToSteps, stepsToMarkdown, widgetHtml, freeWidgetName } from './convert.js';
export { STEP_STATUS } from './progress.js';

export const PANEL_TYPES = ['image', 'iframe', 'progress', 'widget', 'note', 'files', 'editor', 'output', 'terminal', 'git', 'trash'];
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEBOUNCE_MS = 80;
const POLL_MS = 1000;
const WATCH_BACKSTOP_MS = 2000;
const HISTORY_CAP = 50;
const TRASH_CAP = 30; // closed windows kept at most
const MIN_TRASH_PREFIX = 3; // shortest id prefix that restores a closed window
const TRASH_DAYS = 14; // ... and at most this long

export const layout = (dir) => ({
  dir,
  config: path.join(dir, 'config.json'),
  uploads: path.join(dir, 'uploads'),
  panels: path.join(dir, 'panels'),
  progress: path.join(dir, 'progress'),
  diagram: path.join(dir, 'progress', 'diagram.mmd'),
  steps: path.join(dir, 'progress', 'steps.json'),
  plans: path.join(dir, 'progress', 'plans'), // named plans: NAME.json each
  history: path.join(dir, 'progress', 'history'),
  widgets: path.join(dir, 'widgets'),
  commands: path.join(dir, 'commands.json'),
  watches: path.join(dir, 'watches.json'),
  bookmarks: path.join(dir, 'bookmarks.json'),
  schedules: path.join(dir, 'schedules.json'),
  trash: path.join(dir, 'trash'),
  log: path.join(dir, 'log'),
});

/** Publish a complete file with its final permissions; failed writes leave the destination intact. */
export function atomicWrite(file, data, { mode } = {}) {
  if (mode === undefined) {
    try { const st = fs.lstatSync(file); if (st.isFile()) mode = st.mode & 0o777; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd; let created = false;
  try {
    // Exclusive creation avoids following a pre-existing link. Contents stay private while being written.
    fd = fs.openSync(tmp, 'wx', 0o600); created = true;
    fs.writeFileSync(fd, data);
    fs.fchmodSync(fd, mode ?? (0o666 & ~process.umask()));
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file); created = false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* retain the original failure */ } }
    if (created) { try { fs.unlinkSync(tmp); } catch { /* best effort after an I/O failure */ } }
  }
}

export function ensureLayout(dir) {
  const l = layout(dir);
  for (const d of [l.dir, l.uploads, l.panels, l.progress, l.widgets, l.log]) fs.mkdirSync(d, { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n'); // the state dir never belongs in a repo
  return l;
}

/** config.json: token (128 bit, made at first start), port, session. Missing or unreadable: made again. */
export function projectSession(dir) {
  const canonical = fs.realpathSync(dir);
  const project = path.basename(path.dirname(canonical)).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'project';
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
  return `hatch-${project}-${hash}`;
}

export function loadConfig(dir, overrides = {}, { warn = () => {} } = {}) {
  const l = ensureLayout(dir);
  let cfg = {}; let original; const problems = [];
  try { original = fs.readFileSync(l.config); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error(`cannot read ${l.config}: ${e.message}; check its permissions before starting Hatch`); }
  if (original !== undefined) {
    try { cfg = JSON.parse(original.toString('utf8')); }
    catch { problems.push('invalid JSON'); }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { problems.push('configuration must be a JSON object'); cfg = {}; }
  }
  if (typeof cfg.token !== 'string' || cfg.token.length < 16 || /[\s;"\\\x00-\x1f\x7f-\uffff]/.test(cfg.token)) {
    if (cfg.token !== undefined) problems.push('invalid token');
    cfg.token = crypto.randomBytes(16).toString('hex');
  }
  if (cfg.session !== undefined && (typeof cfg.session !== 'string' || !cfg.session.trim() || /[\x00-\x1f\x7f:.]/.test(cfg.session))) {
    problems.push('invalid tmux session'); delete cfg.session;
  }
  if (cfg.allowedHosts !== undefined && (!Array.isArray(cfg.allowedHosts) || cfg.allowedHosts.some((host) => typeof host !== 'string'))) {
    problems.push('allowedHosts must be an array of host names');
    cfg.allowedHosts = Array.isArray(cfg.allowedHosts) ? cfg.allowedHosts.filter((host) => typeof host === 'string') : [];
  }
  cfg.session = overrides.session || cfg.session || projectSession(l.dir);
  if (overrides.port !== undefined) cfg.port = overrides.port;
  if (overrides.host) cfg.host = overrides.host;
  let backup;
  if (original !== undefined && problems.length) {
    backup = `config.invalid-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
    atomicWrite(path.join(dir, backup), original, { mode: 0o600 });
  }
  atomicWrite(l.config, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  if (backup) warn(`Recovered ${problems.join('; ')}. Original saved in ${backup}; review that backup to restore any needed settings.`);
  return cfg;
}

export function saveConfig(dir, cfg) { atomicWrite(layout(dir).config, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 }); }

const parseJson = (file) => {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { return { ok: false, error: e.message }; }
};
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Normalises a panel object from a file or the API. Returns { panel } or { error }. */
export function checkPanel(p, id) {
  if (!isObj(p)) return { error: 'a panel must be a JSON object' };
  if (!PANEL_TYPES.includes(p.type)) return { error: `type must be one of ${PANEL_TYPES.join(', ')}` };
  const props = isObj(p.props) ? p.props : {};
  if (p.type === 'image' && typeof props.src !== 'string') return { error: 'image panels need props.src' };
  if (p.type === 'iframe' && typeof props.url !== 'string') return { error: 'iframe panels need props.url' };
  if (p.type === 'widget' && !NAME_RE.test(String(props.name))) return { error: 'widget panels need props.name (letters, digits, - and _)' };
  if (p.type === 'progress' && props.plan !== undefined && !NAME_RE.test(String(props.plan))) return { error: 'progress panels take an optional props.plan (letters, digits, - and _)' };
  if (p.type === 'note' && typeof props.markdown !== 'string') return { error: 'note panels need props.markdown' };
  if (p.type === 'git' && props.dir !== undefined && typeof props.dir !== 'string') return { error: 'git panels take an optional props.dir' };
  if (p.type === 'terminal' && !NAME_RE.test(String(props.name))) return { error: 'terminal panels need props.name (letters, digits, - and _)' };
  if (p.type === 'output' && typeof props.cmd !== 'string') return { error: 'output panels need props.cmd' };
  if (p.type === 'editor' && typeof props.path !== 'string') return { error: 'editor panels need props.path' };
  if (p.type === 'files' && props.path !== undefined && typeof props.path !== 'string') return { error: 'files panels take an optional props.path' };
  const num = (v) => (Number.isFinite(v) ? Math.round(v) : undefined);
  const out = {
    id, type: p.type, title: typeof p.title === 'string' ? p.title : p.type,
    placement: p.placement === 'dock' ? 'dock' : 'float',
    props, created: typeof p.created === 'string' ? p.created : new Date().toISOString(),
  };
  for (const k of ['x', 'y', 'w', 'h']) if (num(p[k]) !== undefined) out[k] = num(p[k]);
  if (Number.isInteger(p.dockOrder) && p.dockOrder >= 0) out.dockOrder = p.dockOrder; // position in the dock column; absent = after the numbered ones
  if (Number.isFinite(p.opacity)) { const o = Math.max(20, Math.min(100, Math.round(p.opacity))); out.opacity = o; } // percent for this window alone; 100 = explicitly opaque (ignores the global transparency); absent = follows the global setting
  if (p.autoFocus === false) out.autoFocus = false;
  if (p.maximized === true) out.maximized = true;
  if (typeof p.activation === 'string') out.activation = p.activation;
  if (p.minimized === true) out.minimized = true;
  if (p.sticky === true) out.sticky = true; // shown in every workspace
  if (typeof p.ws === 'string' && NAME_RE.test(p.ws) && p.ws !== 'main') out.ws = p.ws; // workspace (virtual desktop); main is the default and is not stored
  return { panel: out };
}

/** Tracks the state dir. `emit(event, data)` receives panel/progress/widget/warning events. */
export function createState(dir, { emit = () => {}, poll = false, log = () => {} } = {}) {
  const l = ensureLayout(dir);
  const panels = new Map();      // id -> panel (last good)
  const warnings = new Map();    // file -> message
  const widgetRev = new Map();   // name -> { rev, sig, meta }
  let progress = { diagram: '', steps: [] };
  let progressSig = '';
  let background = null; // main's background: { url, rev, mode } or null
  const backgrounds = new Map(); // workspace name -> { url, rev, mode } (only those that have one); main is mirrored in `background`
  let wsList = []; let wsSig = ''; // [{ name, id }] from workspaces.json plus names seen on windows
  let fx = { effect: null, intensity: 50 }; // the background effect (null = none) and its intensity
  let transparency = DEFAULT_TRANSPARENCY;  // percent, 0 = opaque
  let watcher = null; let pollTimer = null; let debounce = null; let closed = false;

  const warn = (file, message) => {
    if (message === null) { if (warnings.delete(file)) emit('warning', { file, message: null }); return; }
    if (warnings.get(file) === message) return;
    warnings.set(file, message);
    log(`warning ${file}: ${message}`);
    emit('warning', { file, message });
  };

  const plansApi = createPlans({ dir: l.plans, emit, warn, write: atomicWrite, defaultPlan: () => progress });

  function scanPanels() {
    const seen = new Set();
    for (const f of fs.readdirSync(l.panels)) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
      const id = f.slice(0, -5);
      const rel = `panels/${f}`;
      if (!NAME_RE.test(id)) { warn(rel, 'panel file names must be letters, digits, - and _'); continue; }
      seen.add(id); // a broken file keeps the previous panel on screen
      const r = parseJson(path.join(l.panels, f));
      if (!r.ok) { warn(rel, `invalid JSON: ${r.error}`); continue; }
      const c = checkPanel(r.value, id);
      if (c.error) { warn(rel, c.error); continue; }
      warn(rel, null);
      const before = panels.get(id);
      if (!before || JSON.stringify(before) !== JSON.stringify(c.panel)) {
        panels.set(id, c.panel);
        emit('panel', { action: before ? 'updated' : 'created', panel: c.panel });
      }
    }
    for (const id of [...panels.keys()]) {
      if (!seen.has(id)) { const p = panels.get(id); panels.delete(id); warn(`panels/${id}.json`, null); emit('panel', { action: 'removed', panel: p }); }
    }
  }

  function readSteps() {
    if (!fs.existsSync(l.steps)) { warn('progress/steps.json', null); return []; }
    const r = parseJson(l.steps);
    if (!r.ok) { warn('progress/steps.json', `invalid JSON: ${r.error}`); return null; }
    try {
      const steps = normalizeSteps(r.value);
      warn('progress/steps.json', null); return steps;
    } catch (e) { warn('progress/steps.json', e.message); return null; }
  }

  function scanProgress() {
    let diagram = progress.diagram;
    try { diagram = fs.existsSync(l.diagram) ? fs.readFileSync(l.diagram, 'utf8') : ''; } catch (e) { warn('progress/diagram.mmd', e.message); }
    const steps = readSteps() ?? progress.steps;
    const sig = JSON.stringify([diagram, steps]);
    if (sig === progressSig) return;
    progressSig = sig; progress = { diagram, steps };
    emit('progress', progress);
  }

  // A widget's revision changes when any of its files changes; the browser reloads the iframe on that. The one exception
  // is a top-level data/ folder: it is where a widget keeps what it writes at run time (downloads, saved items), and
  // reloading the widget every time it saves something would wipe what it is showing.
  function dirSig(d) {
    let sig = '';
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const f = path.join(p, e.name);
        if (e.isDirectory()) { if (!(p === d && e.name === 'data')) walk(f); }
        else if (!e.name.endsWith('.tmp')) { const s = fs.statSync(f); sig += `${f}:${s.size}:${s.mtimeMs};`; }
      }
    };
    try { walk(d); } catch { /* vanished while scanning */ }
    return sig;
  }

  function readWidgetMeta(name) {
    const file = path.join(l.widgets, name, 'widget.json');
    if (!fs.existsSync(file)) return {};
    const r = parseJson(file);
    if (!r.ok) { warn(`widgets/${name}/widget.json`, `invalid JSON: ${r.error}`); return null; }
    warn(`widgets/${name}/widget.json`, null);
    return isObj(r.value) ? r.value : {};
  }

  function scanWidgets() {
    const seen = new Set();
    for (const e of fs.readdirSync(l.widgets, { withFileTypes: true })) {
      if (!e.isDirectory() || !NAME_RE.test(e.name)) continue;
      seen.add(e.name);
      const sig = dirSig(path.join(l.widgets, e.name));
      const before = widgetRev.get(e.name);
      if (before && before.sig === sig) continue;
      const meta = readWidgetMeta(e.name) ?? before?.meta ?? {};
      const hasIndex = fs.existsSync(path.join(l.widgets, e.name, 'index.html'));
      if (!hasIndex) warn(`widgets/${e.name}/index.html`, 'missing: a widget needs an index.html');
      else warn(`widgets/${e.name}/index.html`, null);
      const rev = (before?.rev ?? 0) + 1;
      widgetRev.set(e.name, { rev, sig, meta });
      emit('widget', { name: e.name, rev, meta, removed: false });
    }
    for (const name of [...widgetRev.keys()]) {
      if (!seen.has(name)) { widgetRev.delete(name); emit('widget', { name, rev: 0, meta: {}, removed: true }); }
    }
  }

  // Each workspace has its own background (main: the state dir itself, others: workspaces/<id>/); the registry says which exist.
  function scanWorkspaces() {
    const r = listWorkspaces(dir, [...panels.values()]);
    warn('workspaces.json', r.problem || null);
    const sig = JSON.stringify(r.list);
    wsList = r.list;
    if (sig !== wsSig) { wsSig = sig; emit('workspaces', { workspaces: wsList }); }
  }

  function scanBackground() {
    const seen = new Set(); const problems = [];
    for (const w of wsList) {
      const wd = workspaceDir(dir, w);
      const b = findBackground(wd); const m = readMode(wd);
      if (b.problem || m.problem) problems.push(w.name === 'main' ? (b.problem || m.problem) : `workspace ${w.name}: ${b.problem || m.problem}`);
      seen.add(w.name);
      const next = b.name ? { url: `/background/image?${w.name === 'main' ? '' : `ws=${encodeURIComponent(w.name)}&`}v=${b.rev}`, rev: b.rev, mode: m.mode } : null;
      const before = backgrounds.get(w.name) || null;
      if ((next?.rev ?? null) === (before?.rev ?? null) && next?.mode === before?.mode) continue;
      if (next) backgrounds.set(w.name, next); else backgrounds.delete(w.name);
      if (w.name === 'main') background = next;
      emit('background', { ws: w.name, background: next });
    }
    for (const n of [...backgrounds.keys()]) if (!seen.has(n)) { backgrounds.delete(n); emit('background', { ws: n, background: null }); }
    warn('background', problems[0] || null);
  }

  function scanTransparency() {
    const t = readTransparency(dir);
    warn('transparency', t.problem || null);
    if (t.percent === transparency) return;
    transparency = t.percent; emit('transparency', { transparency });
  }

  function scanFx() {
    const f = readFx(dir);
    warn('fx', f.problem || null);
    if (f.effect === fx.effect && f.intensity === fx.intensity) return;
    fx = { effect: f.effect, intensity: f.intensity }; emit('fx', fx);
  }

  function scanSizes() { warn('sizes', readSizes(dir).problem || null); }

  function rescan() {
    if (closed) return;
    try { scanPanels(); scanWorkspaces(); scanProgress(); plansApi.scan(); scanWidgets(); scanBackground(); scanTransparency(); scanFx(); scanSizes(); } catch (e) { log(`rescan failed: ${e.message}`); }
  }

  function schedule() { clearTimeout(debounce); debounce = setTimeout(rescan, DEBOUNCE_MS); }

  function start() {
    rescan();
    if (!poll) {
      try {
        // uploads/ and log/ are noisy and irrelevant here, so they are filtered by name
        watcher = fs.watch(dir, { recursive: true }, (_ev, name) => {
          if (name && (name.endsWith('.tmp') || name.startsWith('log') || name.startsWith('uploads'))) return;
          schedule();
        });
        watcher.on('error', () => { watcher?.close(); watcher = null; clearInterval(pollTimer); pollTimer = setInterval(rescan, POLL_MS); });
        // Backstop: Node's recursive watcher on Linux tracks file inodes, so a file replaced by rename (atomicWrite, so
        // `hatch set background` and every CLI write) stops producing events after the first replacement. A slow rescan
        // catches what the watcher misses; rescan only emits when something actually changed.
        pollTimer = setInterval(rescan, WATCH_BACKSTOP_MS);
        return;
      } catch { /* recursive watch unsupported: poll instead */ }
    }
    pollTimer = setInterval(rescan, POLL_MS);
  }

  function close() { closed = true; clearTimeout(debounce); clearInterval(pollTimer); watcher?.close(); }

  const writePanel = (p) => atomicWrite(path.join(l.panels, `${p.id}.json`), `${JSON.stringify(p, null, 2)}\n`);

  function nextPanelId() {
    let max = 0;
    for (const f of fs.readdirSync(l.panels)) { const m = /^p(\d+)\.json$/.exec(f); if (m) max = Math.max(max, Number(m[1])); }
    return `p${max + 1}`;
  }

  /** Creates a panel file (or returns the existing singleton). Throws Error with .status 400 on bad input. */
  function createPanel(input) {
    const type = input?.type;
    const singleton = type === 'progress' ? (typeof input?.props?.plan === 'string' && NAME_RE.test(input.props.plan) ? `progress-${input.props.plan}` : 'progress') : type === 'terminal' && NAME_RE.test(String(input?.props?.name)) ? `t-${input.props.name}` : type === 'widget' && NAME_RE.test(String(input?.props?.name)) ? `w-${input.props.name}` : null;
    if (singleton && panels.has(singleton)) {
      // An explicit open should bring a minimized singleton back, without resetting its saved geometry.
      const changes = { minimized: false, autoFocus: input.autoFocus !== false, activation: crypto.randomUUID(), ws: input.ws || 'main' };
      for (const key of ['maximized', 'w', 'h', 'placement']) if (input[key] !== undefined) changes[key] = input[key];
      return patchPanel(singleton, changes);
    }
    const id = singleton || nextPanelId();
    const n = panels.size;
    const draft = { placement: type === 'progress' ? 'dock' : 'float', x: 40 + (n % 6) * 28, y: 40 + (n % 6) * 28, ...sizeFor(dir, sizeKey(type, input?.props, input?.id), input?.placement || (type === 'progress' ? 'dock' : 'float')), ...input };
    if (type === 'image') {
      // One preference covers terminal commands and browser-created images. Explicit geometry wins.
      try {
        const cfg = JSON.parse(fs.readFileSync(l.config, 'utf8'));
        const size = /^(\d+)x(\d+)$/i.exec(String(cfg.imageSize || ''));
        if (size && +size[1] >= 180 && +size[1] <= 8192 && +size[2] >= 90 && +size[2] <= 8192) {
          if (input.w === undefined) draft.w = +size[1];
          if (input.h === undefined) draft.h = +size[2];
        }
      } catch { /* a broken preference must not prevent opening an image */ }
    }
    if (type === 'widget') {
      const meta = readWidgetMeta(input.props.name) || {};
      draft.title = input.title || meta.title || input.props.name;
      // widget.json sets the author's default size; what the user last gave this widget beats it, an explicit size beats both
      const mem = readSizes(dir).sizes[sizeKey(type, input.props, input.id)] || {};
      for (const k of ['w', 'h', 'placement']) if (input[k] === undefined && meta[k] !== undefined && !(k !== 'placement' && mem[k] !== undefined)) draft[k] = meta[k];
    }
    const c = checkPanel(draft, id);
    if (c.error) throw Object.assign(new Error(c.error), { status: 400 });
    writePanel(c.panel);
    rescan();
    return panels.get(id) || c.panel;
  }

  function patchPanel(id, patch) {
    if (patch?.ifMarkdown !== undefined) {
      if (typeof patch.ifMarkdown !== 'string') throw Object.assign(new Error('ifMarkdown must be the original note text'), { status: 400 });
      rescan();
      if (warnings.has(`panels/${id}.json`)) throw Object.assign(new Error('note file is invalid; repair it before saving'), { status: 409 });
    }
    const cur = panels.get(id);
    if (!cur) throw Object.assign(new Error(`no panel ${id}`), { status: 404 });
    if (patch?.ifMarkdown !== undefined && (cur.type !== 'note' || cur.props.markdown !== patch.ifMarkdown)) throw Object.assign(new Error('note changed since editing began; your draft was not saved'), { status: 409 });
    const merged = { ...cur };
    for (const k of ['title', 'placement', 'x', 'y', 'w', 'h', 'minimized', 'ws', 'sticky', 'autoFocus', 'maximized', 'activation', 'opacity', 'dockOrder']) if (isObj(patch) && patch[k] !== undefined) merged[k] = patch[k];
    if (isObj(patch?.props)) merged.props = { ...cur.props, ...patch.props };
    const c = checkPanel(merged, id);
    if (c.error) throw Object.assign(new Error(c.error), { status: 400 });
    if (!c.panel.minimized) delete c.panel.minimized;
    if (!c.panel.sticky) delete c.panel.sticky;
    writePanel(c.panel);
    // Only a deliberate resize by the user (remember: true) is remembered; tiling and maximize are not.
    if (patch?.remember === true && (patch.w !== undefined || patch.h !== undefined)) rememberSize(dir, sizeKey(c.panel.type, c.panel.props, c.panel.id), c.panel, c.panel.placement, atomicWrite);
    rescan();
    return panels.get(id);
  }

  /** Turns a window into another type (see convert.js), keeping title, position, size and workspace. Returns the new panel. */
  function convertPanel(id, to) {
    const cur = panels.get(id);
    if (!cur) throw Object.assign(new Error(`no panel ${id}`), { status: 404 });
    to = normalizeTarget(to);
    checkConversion(cur.type, to);
    const keep = {};
    for (const k of ['x', 'y', 'w', 'h', 'placement', 'ws', 'sticky', 'maximized', 'opacity']) if (cur[k] !== undefined) keep[k] = cur[k];
    const base = { title: cur.title, ...keep };
    let draft;
    if (cur.type === 'note' && to === 'progress') {
      const steps = checklistToSteps(cur.props.markdown);
      if (!steps.length) throw Object.assign(new Error('this note has no checklist items ("- [ ] step"); add some, then convert it to progress'), { status: 400 });
      setSteps(steps);
      draft = { type: 'progress', ...base };
    } else if (cur.type === 'progress' && to === 'note') {
      draft = { type: 'note', ...base, props: { markdown: stepsToMarkdown(progress) } };
    } else if (cur.type === 'note' && to === 'widget') {
      const name = freeWidgetName(l.widgets, cur.title);
      fs.mkdirSync(path.join(l.widgets, name), { recursive: true });
      atomicWrite(path.join(l.widgets, name, 'note.md'), cur.props.markdown);
      atomicWrite(path.join(l.widgets, name, 'index.html'), widgetHtml(cur.props.markdown));
      atomicWrite(path.join(l.widgets, name, 'widget.json'), `${JSON.stringify({ title: cur.title }, null, 2)}\n`);
      draft = { type: 'widget', ...base, props: { name } };
    } else { // widget -> note
      const src = path.join(l.widgets, String(cur.props.name), 'note.md');
      if (!fs.existsSync(src)) throw Object.assign(new Error(`widget ${cur.props.name} was not made from a note (no note.md in its folder), so there is no text to turn back into a note; create the note by hand instead`), { status: 400 });
      draft = { type: 'note', ...base, props: { markdown: fs.readFileSync(src, 'utf8') } };
    }
    // singleton targets (progress, widgets) may already be open: reuse them but give them this window's geometry
    const single = draft.type === 'progress' ? (typeof draft.props?.plan === 'string' && NAME_RE.test(draft.props.plan) ? `progress-${draft.props.plan}` : 'progress') : draft.type === 'widget' ? `w-${draft.props.name}` : null;
    let out;
    if (single && panels.has(single)) out = patchPanel(single, { ...base, minimized: false, activation: crypto.randomUUID() });
    else {
      const nid = single || nextPanelId();
      const c = checkPanel({ ...draft, autoFocus: true }, nid);
      if (c.error) throw Object.assign(new Error(c.error), { status: 400 });
      writePanel(c.panel); rescan(); out = panels.get(nid) || c.panel;
    }
    if (out.id !== id) deletePanel(id, { trash: false }); // a conversion is not a close
    return out;
  }

  /** Closing moves the file to trash/<time>-<id>.json (the panel plus `closed`), so a misclick is recoverable. */
  function deletePanel(id, { trash = true } = {}) {
    if (!panels.has(id)) throw Object.assign(new Error(`no panel ${id}`), { status: 404 });
    const file = path.join(l.panels, `${id}.json`);
    if (trash) {
      try {
        const now = new Date();
        fs.mkdirSync(l.trash, { recursive: true });
        const entry = { ...panels.get(id), closed: now.toISOString() };
        atomicWrite(path.join(l.trash, `${now.toISOString().replace(/[:.]/g, '-')}-${id}.json`), `${JSON.stringify(entry, null, 2)}\n`);
        pruneTrash();
      } catch (e) { warn('trash', `could not keep the closed window in trash/ (${e.message}); it was closed anyway`); }
    }
    fs.rmSync(file, { force: true });
    rescan();
  }

  // Trash entries are plain files; unreadable ones warn and are skipped, never fatal.
  function readTrash() {
    if (!fs.existsSync(l.trash)) return [];
    const out = [];
    for (const f of fs.readdirSync(l.trash).filter((n) => n.endsWith('.json')).sort().reverse()) {
      const r = parseJson(path.join(l.trash, f));
      if (!r.ok) { warn(`trash/${f}`, `invalid JSON: ${r.error}`); continue; }
      const c = checkPanel(r.value, String(r.value?.id ?? ''));
      if (c.error) { warn(`trash/${f}`, c.error); continue; }
      warn(`trash/${f}`, null);
      out.push({ trashId: f.slice(0, -5), closed: typeof r.value.closed === 'string' ? r.value.closed : null, panel: c.panel, file: f });
    }
    // Short ids: a hash of the file name is stable while other entries come and go; only a collision lengthens it.
    const hashes = out.map((e) => ({ e, h: crypto.createHash('sha1').update(e.file).digest('hex') }));
    for (const { e, h } of hashes) {
      let n = 6;
      while (n < h.length && hashes.some((o) => o.e !== e && o.h.startsWith(h.slice(0, n)))) n++;
      e.fullId = e.trashId;
      e.trashId = h.slice(0, n);
    }
    return out;
  }

  function pruneTrash() {
    if (!fs.existsSync(l.trash)) return;
    const files = fs.readdirSync(l.trash).filter((n) => n.endsWith('.json')).sort().reverse(); // newest first (ISO names)
    const cutoff = Date.now() - TRASH_DAYS * 86400000;
    files.forEach((f, i) => {
      const t = Date.parse(f.slice(0, 24).replace(/^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z?$/, '$1:$2:$3.$4Z'));
      const age = Number.isFinite(t) ? t : fs.statSync(path.join(l.trash, f)).mtimeMs;
      if (i >= TRASH_CAP || age < cutoff) fs.rmSync(path.join(l.trash, f), { force: true });
    });
  }

  /** Newest first. */
  function listTrash() { pruneTrash(); return readTrash().map(({ trashId, closed, panel }) => ({ trashId, closed, id: panel.id, type: panel.type, title: panel.title, props: panel.props })); }

  /** Reopens a closed window (latest when `trashId` is omitted) with its props and geometry; a taken id gets a fresh one. */
  function restoreTrash(trashId) {
    const entries = readTrash();
    let e = trashId ? entries.find((x) => x.trashId === trashId || x.fullId === trashId) : entries[0];
    // Exact ids win; otherwise 3+ leading chars of the short id are enough when they are unambiguous.
    if (!e && trashId && trashId.length >= MIN_TRASH_PREFIX) {
      const hits = entries.filter((x) => x.trashId.startsWith(trashId));
      if (hits.length > 1) throw Object.assign(new Error(`"${trashId}" matches ${hits.length} closed windows (${hits.map((x) => x.trashId).join(', ')}); type more characters of the id`), { status: 400 });
      e = hits[0];
    }
    if (!e) throw Object.assign(new Error(trashId ? `no closed window ${trashId} in the trash (run "hatch trash" to list the ids)` : 'the trash is empty'), { status: 404 });
    const { id: oldId, created, ...rest } = e.panel;
    const id = panels.has(oldId) ? nextPanelId() : oldId;
    const c = checkPanel({ ...rest, ...(id === oldId && { created }), minimized: false, activation: crypto.randomUUID() }, id);
    if (c.error) throw Object.assign(new Error(c.error), { status: 400 });
    writePanel(c.panel);
    fs.rmSync(path.join(l.trash, e.file), { force: true });
    rescan();
    return panels.get(id) || c.panel;
  }

  function emptyTrash() {
    let n = 0;
    if (fs.existsSync(l.trash)) for (const f of fs.readdirSync(l.trash)) if (f.endsWith('.json')) { fs.rmSync(path.join(l.trash, f), { force: true }); n++; }
    for (const k of [...warnings.keys()]) if (k.startsWith('trash/')) warn(k, null);
    return n;
  }

  // ---- progress ----
  function setDiagram(source) {
    if (fs.existsSync(l.diagram)) {
      const prev = fs.readFileSync(l.diagram, 'utf8');
      if (prev !== source && prev.trim()) {
        fs.mkdirSync(l.history, { recursive: true });
        fs.writeFileSync(path.join(l.history, `${new Date().toISOString().replace(/[:.]/g, '-')}.mmd`), prev);
        const old = fs.readdirSync(l.history).filter((f) => f.endsWith('.mmd')).sort();
        for (const f of old.slice(0, Math.max(0, old.length - HISTORY_CAP))) fs.rmSync(path.join(l.history, f), { force: true });
      }
    }
    atomicWrite(l.diagram, source);
    rescan();
  }

  function setSteps(steps) {
    const clean = normalizeSteps(steps, { updated: new Date().toISOString() });
    atomicWrite(l.steps, `${JSON.stringify(clean, null, 2)}\n`); rescan();
  }

  /** Sets one step's status (creating it when unknown) and keeps the diagram's class line in step. */
  function syncStepsForWrite() {
    rescan();
    if (warnings.has('progress/steps.json')) throw Object.assign(new Error('progress/steps.json is invalid; repair it or replace the plan before updating a step'), { status: 409 });
  }

  function patchStep(id, body) {
    if (!isObj(body)) throw Object.assign(new Error('step update must be an object'), { status: 400 });
    syncStepsForWrite();
    if (body?.status !== undefined && !STEP_STATUS.includes(body.status)) throw Object.assign(new Error(`status must be one of ${STEP_STATUS.join(', ')}`), { status: 400 });
    if (body?.title !== undefined && (typeof body.title !== 'string' || !body.title.trim())) throw Object.assign(new Error('title must be non-empty text'), { status: 400 });
    const steps = [...progress.steps]; const i = steps.findIndex((s) => s.id === id);
    const current = i >= 0 ? steps[i] : { id, title: id };
    const draft = { ...current, updated: new Date().toISOString() };
    for (const key of ['title', 'status', 'detail', 'group']) if (body[key] !== undefined) draft[key] = body[key];
    if (draft.status === undefined) throw Object.assign(new Error('a new step needs a status'), { status: 400 });
    const [step] = normalizeSteps([draft]);
    if (i >= 0) steps[i] = step; else steps.push(step);
    atomicWrite(l.steps, `${JSON.stringify(steps, null, 2)}\n`);
    const styled = applyStepClass(progress.diagram, id, step.status);
    if (styled !== progress.diagram) setDiagram(styled); else rescan();
    return progress.steps.find((s) => s.id === id);
  }

  function updateStep(name, body) {
    if (!isObj(body)) throw Object.assign(new Error('step update must be an object'), { status: 400 });
    syncStepsForWrite();
    if (typeof name !== 'string' || !name.trim()) throw Object.assign(new Error('step name must be non-empty text'), { status: 400 });
    const current = findStep(progress.steps, name);
    const id = current?.id || unusedStepId(progress.steps, name);
    return patchStep(id, { ...body, ...(!current && { title: body.title ?? name }) });
  }

  // ---- named plans (see plans.js); '' is the unnamed plan above ----
  const openPlanWindow = (name) => { if (!panels.has(`progress-${name}`)) createPanel({ type: 'progress', title: name, placement: 'float', autoFocus: false, props: { plan: name } }); };
  const created = (name, r) => { if (r.created) openPlanWindow(name); return r; };
  const plan = {
    names: plansApi.names, resolve: plansApi.resolve,
    get: (name) => (name === '' ? progress : plansApi.get(name)),
    setSteps: (name, steps) => { if (name === '') return setSteps(steps); created(name, plansApi.setSteps(name, steps)); },
    setDiagram: (name, text) => { if (name === '') return setDiagram(text); created(name, plansApi.setDiagram(name, text)); },
    patchStep: (name, id, body) => (name === '' ? patchStep(id, body) : created(name, plansApi.patchStep(name, id, body, applyStepClass)).step),
    updateStep: (name, stepName, body) => (name === '' ? updateStep(stepName, body) : created(name, plansApi.updateStep(name, stepName, body, applyStepClass)).step),
    close(name) { // a named plan: its file and window go; the unnamed plan is emptied (its history stays)
      if (name === '') { setSteps([]); if (fs.existsSync(l.diagram)) setDiagram(''); return; }
      plansApi.remove(name); if (panels.has(`progress-${name}`)) deletePanel(`progress-${name}`);
    },
  };

  return {
    plan,
    layout: l, start, close, rescan,
    snapshot: () => ({ background, backgrounds: Object.fromEntries(backgrounds), workspaces: wsList, transparency, fx, panels: [...panels.values()], progress, plans: plansApi.all(), widgets: [...widgetRev].map(([name, w]) => ({ name, rev: w.rev, meta: w.meta })), warnings: [...warnings].map(([file, message]) => ({ file, message })) }),
    workspaces: () => wsList, backgroundOf: (name) => backgrounds.get(name) || null,
    listPanels: () => [...panels.values()], getPanel: (id) => panels.get(id),
    createPanel, patchPanel, convertPanel, deletePanel, listTrash, restoreTrash, emptyTrash,
    getProgress: () => progress, setDiagram, setSteps, patchStep, updateStep,
    widgetMeta: (name) => widgetRev.get(name)?.meta, widgetNames: () => [...widgetRev.keys()],
    bumpWidget(name) { const w = widgetRev.get(name); if (!w) return false; w.rev += 1; emit('widget', { name, rev: w.rev, meta: w.meta, removed: false }); return true; },
    warn,
  };
}

const DEFAULT_CLASSES = [
  'classDef todo fill:#eee,stroke:#999,color:#333',
  'classDef running fill:#f59e0b,stroke:#b45309,color:#111',
  'classDef done fill:#0f766e,stroke:#0b524c,color:#fff',
  'classDef blocked fill:#dc2626,stroke:#7f1d1d,color:#fff',
  'classDef skipped fill:#ddd,stroke:#aaa,color:#777,stroke-dasharray:3 3',
];

/** Convention, not magic: when the flowchart has a node called `id`, its `class id status` line follows the step. */
export function applyStepClass(diagram, id, status) {
  if (!/^\s*(flowchart|graph)\b/m.test(diagram) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) return diagram;
  const esc = id.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');
  if (!new RegExp(`(^|[\\s;&>|-])${esc}(?=[\\s\\[({>;|&-]|$)`, 'm').test(diagram.replace(new RegExp(`^\\s*class\\s+${esc}\\s+\\w+\\s*;?\\s*$`, 'm'), ''))) return diagram;
  let out = diagram.replace(new RegExp(`^[ \\t]*class[ \\t]+${esc}[ \\t]+\\w+[ \\t]*;?[ \\t]*\\n?`, 'm'), '');
  out = out.replace(/\s*$/, '\n');
  if (!/^\s*classDef\s+running\b/m.test(out)) out += `${DEFAULT_CLASSES.map((c) => `  ${c}`).join('\n')}\n`;
  return `${out}  class ${id} ${status}\n`;
}
