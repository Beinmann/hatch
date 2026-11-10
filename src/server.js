// HTTP server: static files, token check, the terminal bridge, the SSE event hub and the file-backed APIs.
// Every write goes to the state dir (src/state.js); events to the browser come from its watcher, so the CLI,
// the API and hand edits all take the same path.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createBus } from './events.js';
import { createState, loadConfig, saveConfig, layout, atomicWrite, NAME_RE } from './state.js';
import { createTerminal, TerminalError } from './terminal.js';
import { saveUpload, sniff, MIME, MAX_BYTES, UploadError } from './uploads.js';
import { createSources, checkSource, runOnce as runSourceOnce, ARG_RE } from './sources.js';
import { hostAllowed, readAllowedHostsFile, hostRefusedMessage } from './hosts.js';
import * as fsapi from './files.js';
import { pickEditor, vimRequest, which } from './editor.js';
import { createWatches, checkWatches } from './watches.js';
import { createSchedules, checkSchedules } from './schedules.js';
import { createRuns } from './runs.js';
import * as discover from './discover.js';
import * as gitapi from './git.js';
import { findBackground } from './background.js';
import { createLimits } from './limits.js';
import { parseProxyPath, proxyHttp, proxyUpgrade } from './proxy.js';

const PUBLIC = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.mmd': 'text/plain; charset=utf-8', '.LICENSE': 'text/plain; charset=utf-8' };
// The page itself: scripts only from our own files (no inline script, no eval), inline styles allowed (windows are positioned with
// style attributes), connections only back to this server, frames of anything (iframe windows are a feature), never framed by others.
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' http: https:; media-src 'self' data: blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";
const WIDGET_CSP = "sandbox allow-scripts; default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'none'";

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { throw new HttpError(404, 'not found'); } };
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0; let over = false;
    req.on('data', (c) => { n += c.length; if (over) return; if (n > limit) { over = true; chunks.length = 0; reject(new HttpError(413, `body is larger than ${Math.round(limit / 1024)} KB`)); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit = 1024 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  let v; try { v = JSON.parse(buf.toString('utf8')); } catch (e) { throw new HttpError(400, `invalid JSON body: ${e.message}`); }
  return v && typeof v === 'object' ? v : {}; // null, numbers and strings count as an empty body
}

const parseCookies = (h) => Object.fromEntries(String(h || '').split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter(([k]) => k));
function tokenOk(given, token) {
  if (typeof given !== 'string' || !given) return false;
  const a = Buffer.from(given); const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createHatch({ tmuxStatus = false, viewOnly = false, root = null, stateDir, port = 0, host = '0.0.0.0', session, cwd = process.cwd(), attach = null, tmuxBin = 'tmux', procRoot = '/proc', pollState = false, findBin = which, limitsProbe } = {}) {
  stateDir = path.resolve(stateDir);
  fsapi.setRoot(root || process.env.HATCH_ROOT || null); // module-level: one Hatch per process
  const configWarnings = [];
  const cfg = loadConfig(stateDir, { session }, { warn: (message) => configWarnings.push(message) });
  const l = layout(stateDir);
  const allowedHosts = [...(cfg.allowedHosts || []), ...readAllowedHostsFile(stateDir, (m) => configWarnings.push(m))]; // kept apart from cfg: cfg is written back to config.json
  const logFile = path.join(l.log, 'server.log');
  const log = (m) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`); } catch { /* logging must never break the server */ } };

  let state; // assigned below; the bus snapshot reads it lazily
  const bus = createBus((req) => ({ ...state.snapshot(), info: { ...info(), viewOnly: viewOnly || levelOf(req) === 'view' }, asks: [...asks.values()].filter((a) => a.answer === null).map(({ id, question, choices, freeText }) => ({ id, question, choices, freeText })) }), { log });
  // Opt-in (--tmux-status): the running progress step is mirrored into THIS session's tmux status line ("now: build (2/4)").
  let lastStatus = null;
  const mirrorStatus = (prog) => {
    if (!tmuxStatus || attach) return;
    const run = prog.steps.find((s) => s.status === 'running'); const done = prog.steps.filter((s) => s.status === 'done').length;
    const text = run ? `now: ${run.title.replace(/[#%\x00-\x1f]/g, ' ').slice(0, 40)} (${done}/${prog.steps.length}) ` : '';
    if (text === lastStatus) return;
    try { term.tmux(text ? ['set-option', '-t', cfg.session, 'status-right', `${text}| %H:%M `] : ['set-option', '-u', '-t', cfg.session, 'status-right']); lastStatus = text; } catch { /* the session may not exist yet: tried again on the next progress event */ }
  };
  state = createState(stateDir, { emit: (e, d) => { bus.emit(e, d); if (e === 'progress') mirrorStatus(d); }, poll: pollState, log });
  for (const message of configWarnings) state.warn('config.json', message);
  const sources = createSources({ procRoot });
  const gitClient = gitapi.createGit();
  const runs = createRuns({ cwd, notify: (n) => bus.emit('notify', n) });
  const schedules = createSchedules({ file: l.schedules, runs, cwd, notify: (n) => bus.emit('notify', n), warn: (m) => state.warn('schedules.json', m) });
  const clientLog = { stamps: [] }; const authFails = { stamps: [] };
  const asks = new Map(); // id -> { id, question, choices, freeText, answer, created }; in memory only: a restart drops open questions
  const baseUrl = () => `http://127.0.0.1:${server.address()?.port ?? cfg.port}`;
  const watches = createWatches({ file: l.watches, notify: (n) => bus.emit('notify', n), warn: (m) => state.warn('watches.json', m) });
  const extra = new Map(); // terminal windows: name -> terminal; with a command it runs directly in the pty (no tmux), else on its own tmux session (hatch-NAME)
  const termFor = (name, cmd) => {
    if (!NAME_RE.test(name)) throw new HttpError(400, 'terminal names are letters, digits, - and _');
    if (!extra.has(name)) extra.set(name, createTerminal({ session: `${cfg.session}-${name}`, cwd, attach, tmuxBin, env: { HATCH_URL: `http://127.0.0.1:${cfg.port}`, HATCH_STATE: stateDir }, command: cmd }));
    return extra.get(name);
  };
  const term = createTerminal({ session: cfg.session, cwd, attach, tmuxBin, env: {}, onOutput: (b) => watches.feed(b) });
  const info = () => ({ viewOnly, custom: { css: fs.existsSync(path.join(stateDir, 'custom.css')), js: fs.existsSync(path.join(stateDir, 'custom.js')) }, root: fsapi.getRoot(), version: VERSION, session: cfg.session, stateDir, uploadsDir: l.uploads, port: server.address()?.port ?? cfg.port, cwd });

  // ---- static ----
  function serveFile(res, file, headers = {}, req = null) {
    let st;
    try { st = fs.statSync(file); if (!st.isFile()) throw new Error('not a file'); } catch { throw new HttpError(404, 'not found'); }
    try { fs.accessSync(file, fs.constants.R_OK); } catch { throw new HttpError(403, 'not readable by the server user'); }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', ...headers });
    if (req?.method === 'HEAD') return res.end();
    pipeline(fs.createReadStream(file), res, () => { /* a failed or aborted transfer only ends this response */ });
  }
  const inside = (root, rel) => { const f = path.resolve(root, `.${path.sep}${rel}`); return f === root || f.startsWith(root + path.sep) ? f : null; };

  // ---- images by path ----
  function serveImage(res, p) {
    if (!path.isAbsolute(p)) throw new HttpError(400, 'path must be absolute');
    if (fsapi.getRoot() && !p.startsWith(l.uploads + path.sep) && path.dirname(p) !== stateDir) { try { fsapi.abs(p); } catch (e) { throw new HttpError(e.status || 403, e.message); } } // uploads stay viewable
    let fd;
    try {
      fd = fs.openSync(p, 'r');
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new HttpError(400, 'not a regular file');
      if (st.size > MAX_BYTES) throw new HttpError(413, 'image is too large');
      const head = Buffer.alloc(Math.min(st.size, 4096)); fs.readSync(fd, head, 0, head.length, 0);
      const ext = sniff(head);
      const svg = !ext && path.extname(p).toLowerCase() === '.svg' && /^\uFEFF?\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(head.toString('utf8'));
      if (!ext && !svg) throw new HttpError(415, 'not a PNG, JPEG, GIF, WebP or SVG image');
      const svgHeaders = svg ? { 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; frame-ancestors 'none'" } : {};
      res.writeHead(200, { ...svgHeaders, 'content-type': svg ? 'image/svg+xml' : MIME[ext], 'content-length': st.size, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' });
      pipeline(fs.createReadStream(p, { fd, autoClose: true }), res, () => {});
      fd = undefined;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(e.code === 'ENOENT' ? 404 : 403, e.code === 'ENOENT' ? `no such file: ${p}` : `cannot read ${p}: ${e.code || e.message}`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  function readCommands() {
    if (!fs.existsSync(l.commands)) return [];
    try {
      const v = JSON.parse(fs.readFileSync(l.commands, 'utf8'));
      if (!Array.isArray(v)) throw new Error('must be a JSON array');
      state.warn('commands.json', null);
      return v.filter((c) => c && typeof c.name === 'string' && typeof c.text === 'string').map((c) => ({ name: c.name, text: c.text, enter: c.enter !== false, ...(c.paste === true && { paste: true }) }));
    } catch (e) { state.warn('commands.json', `invalid: ${e.message}`); return []; }
  }

  // ---- widgets ----
  function widgetSource(name, srcName) {
    const meta = state.widgetMeta(name);
    if (!meta) throw new HttpError(404, `no widget ${name}`);
    const raw = (Array.isArray(meta.sources) ? meta.sources : []).find((s) => s?.name === srcName);
    if (!raw) throw new HttpError(404, `widget ${name} declares no source ${srcName}`);
    const c = checkSource(raw);
    if (c.error) throw new HttpError(400, c.error);
    // placeholders in exec commands: {{widget}} (this widget's folder name), {{session}} (tmux session), {{state}} (state dir), {{cwd}} (server dir); values are shell-quoted
    if (c.def.kind === 'exec') { const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`; c.def.cmd = c.def.cmd.replaceAll('{{widget}}', () => q(name)).replaceAll('{{session}}', () => q(cfg.session)).replaceAll('{{state}}', () => q(stateDir)).replaceAll('{{cwd}}', () => q(cwd)); } // function replacers: a '$' in a path must not be read as a replacement pattern
    return c.def;
  }

  const limits = createLimits({ probe: limitsProbe });
  let calls = 0; const MAX_CALLS = 4;
  const subs = new Map(); // key -> { cids:Set, off }
  const byClient = new Map(); // cid -> Set of keys
  function subscribeKey(cid, key, widget, source, def) {
    let sub = subs.get(key);
    if (!sub) { sub = { cids: new Set(), off: null }; subs.set(key, sub); sub.off = sources.subscribe(def, (value, ts) => bus.emit('source', { widget, source, value, ts })); }
    sub.cids.add(cid); if (!byClient.has(cid)) byClient.set(cid, new Set()); byClient.get(cid).add(key);
  }
  function unsub(cid, key) {
    const sub = subs.get(key); byClient.get(cid)?.delete(key);
    if (!sub) return; sub.cids.delete(cid);
    if (!sub.cids.size) { sub.off(); subs.delete(key); }
  }
  const streamsOf = new Map(); // cid -> open /api/events streams (a reconnect overlaps the old, half-open one)
  const dropClient = (cid) => { for (const key of [...(byClient.get(cid) || [])]) unsub(cid, key); byClient.delete(cid); };

  function sse(req, res, subscribe) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const off = subscribe((value, ts) => res.write(`data: ${JSON.stringify({ value, ts })}\n\n`));
    const hb = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(hb); off(); });
  }

  function putWidget(name, body) {
    if (!NAME_RE.test(name)) throw new HttpError(400, 'widget names are letters, digits, - and _');
    const dir = path.join(l.widgets, name);
    const files = body?.files && typeof body.files === 'object' ? body.files : null;
    if (!files || typeof files['index.html'] !== 'string') throw new HttpError(400, 'body needs files: { "index.html": "<html>...", ... }');
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const f = inside(dir, rel);
      if (!f || typeof content !== 'string') throw new HttpError(400, `bad file entry ${rel}`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      atomicWrite(f, content);
    }
    if (body.meta && typeof body.meta === 'object') atomicWrite(path.join(dir, 'widget.json'), `${JSON.stringify(body.meta, null, 2)}\n`);
    state.rescan();
  }

  // GET routes a view-only mirror may serve: the page, events, the terminal stream, panel/progress/widget data, widget sources, uploads.
  const VIEW_OK = [/^\/api\/(health|info|events|panels|progress|widgets|term|clientlog)(\/|$)/, /^\/api\/source\//, /^\/api\/runs\/r\w+\/stream$/, /^\/api\/pterm\/[\w-]+\/stream$/, /^\/files\/uploads\//, /^\/custom\//, /^\/background\/image$/];
  const VIEW_POST = new Set(['/api/sub', '/api/clientlog']); // widget subscriptions and error reports change nothing on the box
  const viewAllowed = (m, p) => (VIEW_POST.has(p) && m === 'POST') || (m === 'GET' || m === 'HEAD') && (!p.startsWith('/api/') && !p.startsWith('/proxy/') || VIEW_OK.some((r) => r.test(p))) && !/^\/api\/term\/(input|resize)/.test(p);
  // Two token levels: the full token, and an optional view token (config.json viewToken, made by `hatch-server url --view`) that
  // only ever gets the view-only subset of the API. config.json is re-read for it, so a new view token works without a restart.
  const readEditorPref = () => { try { return JSON.parse(fs.readFileSync(l.config, 'utf8')).editor; } catch { return undefined; } }; // read per call so a hand edit applies at once
  const readViewToken = () => { try { const t = JSON.parse(fs.readFileSync(l.config, 'utf8')).viewToken; return typeof t === 'string' && t.length >= 16 ? t : null; } catch { return null; } };
  const levelOf = (req) => {
    const given = [req.headers['x-token'], parseCookies(req.headers.cookie).hatch_token];
    if (given.some((g) => tokenOk(g, cfg.token))) return 'full';
    const vt = given.some((g) => g) ? readViewToken() : null;
    return vt && given.some((g) => tokenOk(g, vt)) ? 'view' : null;
  };
  const isAuthed = (req) => !!levelOf(req);
  // Streams opened with a view token are re-checked every 5 s: `hatch-server url --revoke-view` ends them (full-token streams are never cut).
  const viewStreams = new Set();
  const trackView = (req, res) => { const e = { req, res }; viewStreams.add(e); res.on('close', () => viewStreams.delete(e)); };
  const viewWatch = setInterval(() => { for (const e of [...viewStreams]) if (!levelOf(e.req)) { viewStreams.delete(e); try { e.res.end(); e.req.destroy(); } catch { /* gone */ } } }, 5000);
  viewWatch.unref();

  // The "desktop": a set of live gadgets laid out on a 1280x800 page (use the palette's Tile to refit). Copies the
  // example widgets that are missing, opens the progress panel and one window per gadget.
  const EXAMPLES = fileURLToPath(new URL('../examples/widgets/', import.meta.url));
  const DESKTOP = [['graph', 20, 20, 440, 210], ['sysinfo', 480, 20, 300, 210], ['clock', 800, 20, 300, 190], ['top', 20, 250, 520, 270], ['git', 560, 250, 500, 270], ['log-tail', 20, 540, 520, 200]];
  const exampleList = () => fs.readdirSync(EXAMPLES, { withFileTypes: true }).filter((e) => e.isDirectory() && NAME_RE.test(e.name)).map((e) => {
    let title = e.name; try { title = JSON.parse(fs.readFileSync(path.join(EXAMPLES, e.name, 'widget.json'), 'utf8')).title || e.name; } catch { /* keep the name */ }
    return { name: e.name, title };
  }).concat([{ name: 'trash', title: 'Trash', open: state.listPanels().some((q) => q.type === 'trash') }]) // built in: a panel type, not a folder in examples/
    .sort((a, b) => a.name.localeCompare(b.name));
  // The example tails /var/log/syslog, which many boxes lack or do not let us read: fall back to Hatch's own log.
  function useReadableLog(name) {
    const meta = state.widgetMeta(name); const src = meta?.sources?.[0];
    if (src?.path !== '/var/log/syslog') return;
    try { fs.accessSync(src.path, fs.constants.R_OK); return; } catch { /* fall back */ }
    atomicWrite(path.join(l.widgets, name, 'widget.json'), JSON.stringify({ ...meta, sources: [{ ...src, path: path.join(l.log, 'server.log') }] }, null, 2));
    state.rescan();
  }
  /** Copies an example into widgets/ (keeping an existing copy) and opens it as a window. */
  function openExample(name, options = {}) {
    if (!exampleList().some((e) => e.name === name)) throw new HttpError(404, `no example widget ${name}`);
    if (name === 'top') return openTop(options);
    if (name === 'trash') return state.listPanels().find((q) => q.type === 'trash') || state.createPanel({ type: 'trash', title: 'Trash' }); // one trash window is enough
    const dir = path.join(l.widgets, name);
    if (!fs.existsSync(dir)) fs.cpSync(path.join(EXAMPLES, name), dir, { recursive: true });
    if (name === 'log-tail') useReadableLog(name);
    const windowOptions = {};
    for (const key of ['w', 'h', 'autoFocus', 'maximized', 'ws']) if (options?.[key] !== undefined) windowOptions[key] = options[key];
    state.rescan(); return state.createPanel({ type: 'widget', props: { name }, ...windowOptions });
  }
  // "top" is a real terminal window (keyboard works): htop when installed, else plain top
  const TOP_CMD = 'if command -v htop >/dev/null 2>&1; then exec htop; else exec top; fi';
  function openTop(geometry = {}) {
    const windowOptions = {};
    for (const key of ['x', 'y', 'w', 'h', 'autoFocus', 'maximized', 'ws']) if (geometry?.[key] !== undefined) windowOptions[key] = geometry[key];
    // an old non-interactive top widget window would sit beside the terminal: replace it
    for (const old of state.listPanels().filter((q) => q.type === 'widget' && q.props?.name === 'top')) state.deletePanel(old.id);
    return state.createPanel({ type: 'terminal', title: 'top', props: { name: 'top', cmd: TOP_CMD }, ...windowOptions });
  }
  function openDesktop() {
    const opened = [];
    for (const [name, x, y, w, h] of DESKTOP) {
      if (name === 'top') {
        openTop({ x, y, w, h }); opened.push(name); continue;
      }
      const dir = path.join(l.widgets, name);
      if (!fs.existsSync(dir)) fs.cpSync(path.join(EXAMPLES, name), dir, { recursive: true });
      state.rescan();
      if (name === 'log-tail') useReadableLog(name);
      state.createPanel({ type: 'widget', props: { name }, x, y, w, h }); opened.push(name);
    }
    state.createPanel({ type: 'progress', title: 'Progress', placement: 'dock' });
    return { opened };
  }

  // ---- routing ----
  async function route(req, res, url) {
    const p = url.pathname; const m = req.method;
    let g;

    // widget files + SDK: opaque-origin iframes cannot send our cookie for sub-resources, so these are token-free
    // (they hold only what Claude wrote; revisit in the security pass)
    if (p === '/sdk.js') return serveFile(res, path.join(PUBLIC, 'sdk.js'), {}, req);
    if (p.startsWith('/widgets/')) {
      const rest = p.slice('/widgets/'.length);
      const name = rest.split('/')[0];
      if (!NAME_RE.test(name)) throw new HttpError(404, 'not found');
      const f = inside(path.join(l.widgets, name), safeDecode(rest.slice(name.length + 1)) || 'index.html');
      if (!f) throw new HttpError(404, 'not found');
      const target = fs.existsSync(f) && fs.statSync(f).isDirectory() ? path.join(f, 'index.html') : f;
      // these files are served without the token, so a symlink inside a widget folder must not lead anywhere outside it
      try { const real = fs.realpathSync(target); const base = path.join(fs.realpathSync(l.widgets), name); if (fs.lstatSync(path.join(l.widgets, name)).isSymbolicLink()) throw new HttpError(404, 'not found'); if (real !== base && !real.startsWith(base + path.sep)) throw new HttpError(404, 'not found'); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(404, 'not found'); }
      return serveFile(res, target, { 'content-security-policy': WIDGET_CSP }, req);
    }

    // ---- auth ----
    const level = levelOf(req); const authed = !!level;
    const qt = url.searchParams.get('t');
    const qLevel = qt ? (tokenOk(qt, cfg.token) ? 'full' : (readViewToken() && tokenOk(qt, readViewToken()) ? 'view' : null)) : null;
    // the ?t= link logs in when nobody is logged in, or when it carries a higher level than the cookie (view cookie, full link)
    if (qLevel && (!authed || (qLevel === 'full' && level !== 'full')) && m === 'GET' && !p.startsWith('/api/')) {
      res.writeHead(302, { 'set-cookie': `hatch_token=${qLevel === 'full' ? cfg.token : qt}; Path=/; SameSite=Strict; HttpOnly; Max-Age=31536000`, location: p === '/' ? '/' : p, 'cache-control': 'no-store' });
      return res.end();
    }
    if (!authed) {
      // failed logins are logged (at most 10 a minute) so attempts from the network can be seen in the server log
      const now = Date.now(); authFails.stamps = authFails.stamps.filter((x) => now - x < 60000);
      if (authFails.stamps.length < 10) { authFails.stamps.push(now); log(`auth failed: ${req.method} ${p.slice(0, 80).replace(/[\x00-\x1f]/g, ' ')} from ${String(req.socket.remoteAddress || '?').replace(/^::ffff:/, '')} (${req.headers['user-agent'] ? String(req.headers['user-agent']).replace(/[\x00-\x1f]/g, ' ').slice(0, 60) : 'no user agent'})`); }
      if (p.startsWith('/api/')) throw new HttpError(401, 'missing or wrong token: open the URL printed by `hatch-server serve` (it ends in ?t=...)');
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><title>Hatch</title><body style="font:16px system-ui;padding:2em"><h1>Hatch</h1><p>Token needed. Open the URL printed by <code>hatch-server serve</code> (it ends in <code>?t=...</code>).</p>');
    }

    // View-only mirror: nothing that changes state or reads the box's files is allowed; watching is.
    const viewing = viewOnly || level === 'view';
    if (level === 'view' && (p === '/api/events' || p === '/api/term/stream' || p.startsWith('/api/source/') || /^\/api\/(runs|pterm)\/[^/]+\/stream$/.test(p))) trackView(req, res);
    if (viewing && !viewAllowed(m, p)) throw new HttpError(403, viewOnly ? 'this Hatch is view-only (started with --view-only)' : 'this link is view-only: use the full URL to change anything');
    const extraWatch = viewing && /^\/api\/pterm\/([\w-]+)\/stream$/.exec(p);
    if (extraWatch && !extra.has(extraWatch[1]) && !state.listPanels().some((panel) => panel.type === 'terminal' && panel.props.name === extraWatch[1])) throw new HttpError(404, 'no existing terminal window with that name');

    const prox = parseProxyPath(p);
    if (prox) return proxyHttp(req, res, { ...prox, rest: prox.rest + url.search }, { selfPort: server.address()?.port });

    // ---- API ----
    if (p.startsWith('/api/')) {
      if (p === '/api/health') return json(res, 200, { ok: true });
      if (p === '/api/info') return json(res, 200, { ...info(), viewOnly: viewing });
      if (p === '/api/events') {
        const cid = url.searchParams.get('cid') || ''; streamsOf.set(cid, (streamsOf.get(cid) || 0) + 1);
        return bus.subscribe(req, res, () => { const n = (streamsOf.get(cid) || 1) - 1; if (n > 0) streamsOf.set(cid, n); else { streamsOf.delete(cid); dropClient(cid); } });
      }
      if (p === '/api/sub' && m === 'POST') {
        // Widget data rides the one /api/events stream: browsers allow only ~6 connections per origin, and a stream per
        // widget source starved the page. A client says which sources it wants; data is broadcast as `source` events.
        const b = await readJson(req); const key = `${b.widget}/${b.source}`;
        if (!b.cid || typeof b.widget !== 'string' || typeof b.source !== 'string') throw new HttpError(400, 'sub needs cid, widget and source');
        if (b.on === false) { unsub(b.cid, key); return json(res, 200, { ok: true }); }
        const def = widgetSource(b.widget, b.source); subscribeKey(b.cid, key, b.widget, b.source, def);
        return json(res, 200, { ok: true });
      }

      if (p === '/api/call' && m === 'POST') {
        // hatch.call: run an exec source once for a widget, with one argument in $HATCH_ARG. Full token only (not in VIEW_POST),
        // because it can change things (the example deletes files); a few at a time so a widget cannot fork-bomb the box.
        const b = await readJson(req);
        if (typeof b?.widget !== 'string' || typeof b.source !== 'string') throw new HttpError(400, 'call needs widget and source');
        const def = widgetSource(b.widget, b.source);
        if (def.kind !== 'exec') throw new HttpError(400, `source ${b.source} is ${def.kind}; hatch.call only runs exec sources`);
        if (b.arg !== undefined && (typeof b.arg !== 'string' || !ARG_RE.test(b.arg))) throw new HttpError(400, 'arg must be a file-name-like word: letters, digits, _ . - and spaces, starting with a letter or digit, at most 200 characters');
        if (calls >= MAX_CALLS) throw new HttpError(429, `already running ${MAX_CALLS} widget calls; wait for one to finish`);
        calls++;
        try { return json(res, 200, { value: await runSourceOnce(def, b.arg) }); } finally { calls--; }
      }

      if (p === '/api/term' && m === 'GET') return json(res, 200, { ...term.ensure(), viewOnly: viewing });
      if (p === '/api/term/stream' && m === 'GET') return term.watch(req, res);
      if (p === '/api/term/input' && m === 'POST') { term.input((await readJson(req)).data); return json(res, 200, { ok: true }); }
      if ((g = /^\/api\/pterm\/([\w-]+)\/(stream|input|resize|windows|alive)$/.exec(p)) || (g = /^\/api\/pterm\/([\w-]+)$/.exec(p))) {
        // terminal windows: same bridge as the main terminal, one tmux session each
        if (!g[2] && m === 'POST') { const b = await readJson(req); return json(res, 200, termFor(g[1], typeof b.cmd === 'string' ? b.cmd : null).ensure()); }
        if (!g[2] && m === 'DELETE') { const t = extra.get(g[1]); if (t) { t.kill(); extra.delete(g[1]); } return json(res, 200, { ok: true }); }
        // asked before reconnecting: no session left means the window's program ended (termFor/ensure would start it again)
        if (g[2] === 'alive' && m === 'GET') return json(res, 200, { alive: extra.has(g[1]) ? extra.get(g[1]).alive() : false });
        const t = termFor(g[1]);
        if (g[2] === 'stream' && m === 'GET') return t.watch(req, res);
        if (g[2] === 'input' && m === 'POST') { t.input((await readJson(req)).data); return json(res, 200, { ok: true }); }
        if (g[2] === 'resize' && m === 'POST') { const b = await readJson(req); return json(res, 200, t.resize(b.cols, b.rows)); }
      }
      if (p === '/api/term/resize' && m === 'POST') { const b = await readJson(req); return json(res, 200, term.resize(b.cols, b.rows)); }

      if (p === '/api/upload' && m === 'POST') {
        const buf = await readBody(req, MAX_BYTES);
        const r = saveUpload(l.uploads, buf);
        return json(res, 200, { path: r.path, name: r.name, url: `/files/uploads/${r.name}`, bytes: r.bytes });
      }
      if (p === '/api/file' && m === 'GET') return serveImage(res, url.searchParams.get('path') || '');

      if (p === '/api/fs/list' && m === 'GET') return json(res, 200, fsapi.list(url.searchParams.get('path') || cwd));
      if (p === '/api/fs/resolve' && m === 'GET') {
        // a path printed in the terminal: relative ones are tried against the server dir and the tmux pane's current dir
        const want = url.searchParams.get('path') || ''; const tries = [];
        if (path.isAbsolute(want)) tries.push(want);
        else { tries.push(path.resolve(cwd, want)); try { const pc = term.tmux(['display-message', '-p', '-t', `${cfg.session}:`, '#{pane_current_path}']); if (pc) tries.push(path.resolve(pc, want)); } catch { /* no tmux */ } }
        const hit = tries.find((f) => { try { fsapi.abs(f); return fs.statSync(f).isFile(); } catch { return false; } });
        if (!hit) throw new HttpError(404, `no such file: ${want} (looked in ${tries.map((t) => path.dirname(t)).join(', ')})`);
        return json(res, 200, { path: hit });
      }
      if (p === '/api/fs/read' && m === 'GET') return json(res, 200, fsapi.readText(url.searchParams.get('path')));
      if (p === '/api/fs/write' && m === 'PUT') { const b = await readJson(req, 2 * 1024 * 1024); return json(res, 200, fsapi.writeText(b.path, b.text, b.mtime)); }
      if (p === '/api/fs/mkdir' && m === 'POST') return json(res, 200, fsapi.mkdir((await readJson(req)).path));
      if (p === '/api/fs/newfile' && m === 'POST') return json(res, 200, fsapi.newFile((await readJson(req)).path));
      if (p === '/api/fs/rename' && m === 'POST') { const b = await readJson(req); return json(res, 200, fsapi.rename(b.from, b.to)); }
      if (p === '/api/fs/delete' && m === 'POST') { const b = await readJson(req); return json(res, 200, fsapi.remove(b.path, b.recursive === true)); }
      if (p === '/api/fs/upload' && m === 'POST') {
        const r = fsapi.saveFile(url.searchParams.get('dir'), url.searchParams.get('name'), await readBody(req, fsapi.UPLOAD_MAX), url.searchParams.get('overwrite') === '1');
        return json(res, 200, r);
      }
      if (p === '/api/fs/download' && m === 'GET') {
        const f = url.searchParams.get('path') || '';
        try { fsapi.abs(f); } catch (e) { throw new HttpError(e.status || 400, e.message); }
        let st; try { st = fs.statSync(f); if (!path.isAbsolute(f) || !st.isFile()) throw new Error(); } catch { throw new HttpError(404, `no such file (absolute path needed): ${f}`); }
        try { fs.accessSync(f, fs.constants.R_OK); } catch { throw new HttpError(403, `not readable by the server user: ${f}`); }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(f))}`, 'x-content-type-options': 'nosniff' });
        return pipeline(fs.createReadStream(f), res, () => {});
      }
      if (p === '/api/panels' && m === 'GET') return json(res, 200, state.listPanels());
      if (p === '/api/panels' && m === 'POST') return json(res, 201, state.createPanel(vimRequest(await readJson(req), pickEditor(readEditorPref(), findBin))));
      if (m === 'POST' && (g = /^\/api\/panels\/([\w-]+)\/convert$/.exec(p))) return json(res, 200, state.convertPanel(g[1], (await readJson(req))?.to));
      if (p === '/api/trash' && m === 'GET') return json(res, 200, state.listTrash());
      if (p === '/api/trash' && m === 'DELETE') return json(res, 200, { removed: state.emptyTrash() });
      if (p === '/api/trash/restore' && m === 'POST') { const b = await readJson(req); return json(res, 200, state.restoreTrash(typeof b?.trashId === 'string' ? b.trashId : undefined)); }
      if ((g = /^\/api\/panels\/([\w-]+)$/.exec(p))) {
        if (m === 'GET') { const pn = state.getPanel(g[1]); if (!pn) throw new HttpError(404, `no panel ${g[1]}`); return json(res, 200, pn); }
        if (m === 'PATCH') return json(res, 200, state.patchPanel(g[1], await readJson(req)));
        if (m === 'DELETE') { state.deletePanel(g[1]); return json(res, 200, { ok: true }); }
      }

      if (p === '/api/progress' && m === 'GET') return json(res, 200, state.getProgress());
      if (p === '/api/progress/diagram') {
        if (m === 'GET') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(state.getProgress().diagram); }
        if (m === 'PUT') { state.setDiagram((await readBody(req, 1024 * 1024)).toString('utf8')); return json(res, 200, { ok: true }); }
      }
      if (p === '/api/progress/history' && m === 'GET') return json(res, 200, fs.existsSync(l.history) ? fs.readdirSync(l.history).filter((f) => f.endsWith('.mmd')).sort() : []);
      if ((g = /^\/api\/progress\/history\/([\w.-]+\.mmd)$/.exec(p)) && m === 'GET') {
        const f = inside(l.history, g[1]); if (!f || !fs.existsSync(f)) throw new HttpError(404, `no history entry ${g[1]}`);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(fs.readFileSync(f, 'utf8'));
      }
      if (p === '/api/progress/steps') {
        if (m === 'GET') return json(res, 200, state.getProgress().steps);
        if (m === 'POST') { const body = await readJson(req); return json(res, 200, state.updateStep(body.name, body)); }
        if (m === 'PUT') { state.setSteps(await readJson(req)); return json(res, 200, { ok: true }); }
      }
      if ((g = /^\/api\/progress\/steps\/([^/]+)$/.exec(p)) && m === 'PATCH') { state.patchStep(decodeURIComponent(g[1]), await readJson(req)); return json(res, 200, { ok: true }); }

      if (p === '/api/limits' && m === 'GET') return json(res, 200, await limits.get(url.searchParams.get('refresh') === '1'));
      if (p === '/api/desktop' && m === 'POST') return json(res, 200, openDesktop());
      if (p === '/api/examples' && m === 'GET') return json(res, 200, exampleList());
      if ((g = /^\/api\/examples\/([\w-]+)\/open$/.exec(p)) && m === 'POST') return json(res, 200, openExample(g[1], await readJson(req)));
      if ((g = /^\/api\/git\/(status|stage|unstage|commit)$/.exec(p))) {
        const body = m === 'POST' ? await readJson(req) : {}; const want = body.dir ?? url.searchParams.get('dir') ?? '';
        if (typeof want !== 'string') throw new HttpError(400, 'dir must be a string');
        const dir = path.isAbsolute(want) ? want : cwd;
        try {
          if (g[1] === 'status' && m === 'GET') return json(res, 200, await gitClient.status(dir));
          if (g[1] === 'stage' && m === 'POST') return json(res, 200, await gitClient.stage(dir, body.paths));
          if (g[1] === 'unstage' && m === 'POST') return json(res, 200, await gitClient.unstage(dir, body.paths));
          if (g[1] === 'commit' && m === 'POST') return json(res, 200, await gitClient.commit(dir, body.message));
        } catch (e) { if (e instanceof gitapi.GitError) throw new HttpError(e.status, e.message); throw e; }
      }
      if (p === '/api/files' && m === 'GET') return json(res, 200, { dir: cwd, files: discover.files(cwd) });
      if (p === '/api/tasks' && m === 'GET') return json(res, 200, discover.tasks(cwd));
      if (p === '/api/ports' && m === 'GET') return json(res, 200, discover.ports(procRoot).filter((x) => x.port !== server.address()?.port));
      if (p === '/api/report' && m === 'GET') {
        // a markdown summary of the session for hand-offs: progress, runs, windows
        const prog = state.getProgress();
        const icon = { todo: '[ ]', running: '[~]', done: '[x]', blocked: '[!]', skipped: '[-]' };
        const lines = [`# Hatch session report`, '', `Generated ${new Date().toISOString()} for tmux session \`${cfg.session}\` in \`${cwd}\`.`, ''];
        lines.push('## Progress', '', ...(prog.steps.length ? prog.steps.map((s) => `- ${icon[s.status] || '[ ]'} ${s.title} (${s.status})`) : ['No steps recorded.']), '');
        if (prog.diagram.trim()) lines.push('```mermaid', prog.diagram.trim(), '```', '');
        const rs = runs.all(); lines.push('## Runs', '', ...(rs.length ? rs.map((r) => `- \`${r.cmd.slice(0, 100)}\`: ${r.state === 'running' ? 'running' : `exit ${r.code}${r.ended ? ` in ${((r.ended - r.started) / 1000).toFixed(1)}s` : ''}`}`) : ['No runs.']), '');
        const ps = state.listPanels(); lines.push('## Windows', '', ...(ps.length ? ps.map((x) => `- ${x.type}: ${x.title}${x.ws ? ` (workspace ${x.ws})` : ''}`) : ['None open.']), '');
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' }); return res.end(lines.join('\n'));
      }
      if (p === '/api/clientlog' && m === 'POST') {
        // the page reports its own JavaScript errors so they can be found in the server log (at most 30 per minute)
        const b = await readJson(req, 16 * 1024); const t = Date.now();
        clientLog.stamps = clientLog.stamps.filter((x) => t - x < 60000);
        const clean = (v, n) => String(v ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, n); // no newlines or escape codes: they could forge log lines or replay in a terminal that tails the log
        let big = false; try { big = fs.statSync(logFile).size > 5 * 1024 * 1024; } catch { /* no log yet */ }
        if (!big && clientLog.stamps.length < 30) { clientLog.stamps.push(t); log(`client error: ${clean(b.message, 300)} at ${clean(b.source, 120)}:${Number(b.line) || 0} [${clean(b.agent, 80)}]`); }
        return json(res, 200, { ok: true });
      }
      if (p === '/api/copy' && m === 'POST') {
        // box -> browser clipboard: the page copies it, or offers a Copy button when the browser wants a click first
        const b = await readJson(req, 2 * 1024 * 1024);
        if (typeof b.text !== 'string' || !b.text) throw new HttpError(400, 'copy needs text');
        bus.emit('copy', { text: b.text.slice(0, 1024 * 1024), label: typeof b.label === 'string' ? b.label.slice(0, 80) : '' });
        return json(res, 200, { ok: true, bytes: Buffer.byteLength(b.text) });
      }
      if (p === '/api/runs' && m === 'POST') { const b = await readJson(req); return json(res, 201, runs.start(b.cmd, typeof b.cwd === 'string' && path.isAbsolute(b.cwd) ? b.cwd : undefined)); }
      if (p === '/api/runs' && m === 'GET') return json(res, 200, runs.list());
      if ((g = /^\/api\/runs\/(r\w+)(\/stream|\/output)?$/.exec(p))) {
        if (m === 'GET' && g[2] === '/output') { const text = runs.output(g[1], url.searchParams.has('max') ? Number(url.searchParams.get('max')) : undefined); res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); return res.end(text); }
        if (m === 'GET' && g[2]) return runs.watch(g[1], req, res);
        if (m === 'GET') return json(res, 200, runs.get(g[1]));
        if (m === 'DELETE') return json(res, 200, runs.stop(g[1]));
      }
      if (p === '/api/ask' && m === 'POST') {
        // a question for the user (Emacs y-or-n-p idea): the browser shows a dialog, `hatch ask` waits for the answer
        const b = await readJson(req);
        if (typeof b.question !== 'string' || !b.question.trim()) throw new HttpError(400, 'ask needs a question');
        if (b.freeText !== undefined && typeof b.freeText !== 'boolean') throw new HttpError(400, 'freeText must be true or false');
        if (b.choices !== undefined && (!Array.isArray(b.choices) || b.choices.length > 8 || b.choices.some((choice) => typeof choice !== 'string' || !choice.trim() || choice.length > 200) || new Set(b.choices).size !== b.choices.length)) throw new HttpError(400, 'choices must be at most 8 distinct non-empty strings of up to 200 characters');
        const choices = Array.isArray(b.choices) && b.choices.length ? [...b.choices] : (b.freeText ? [] : ['Yes', 'No']);
        const a = { id: `q${crypto.randomBytes(8).toString('hex')}`, question: b.question.slice(0, 1000), choices, freeText: !!b.freeText, answer: null, created: Date.now() };
        asks.set(a.id, a);
        bus.emit('ask', { id: a.id, question: a.question, choices, freeText: a.freeText });
        bus.emit('notify', { text: `Claude asks: ${a.question.slice(0, 200)}`, level: 'warn' });
        return json(res, 201, { id: a.id });
      }
      if ((g = /^\/api\/ask\/(q\w+)(\/answer)?$/.exec(p))) {
        const a = asks.get(g[1]); if (!a) throw new HttpError(404, `no question ${g[1]} (it may have been cancelled or the server restarted)`);
        if (m === 'GET' && !g[2]) return json(res, 200, { id: a.id, answered: a.answer !== null, answer: a.answer });
        if (m === 'POST' && g[2]) {
          const b = await readJson(req); if (typeof b.answer !== 'string') throw new HttpError(400, 'answer must be a string');
          if (asks.get(a.id) !== a) throw new HttpError(404, 'this question was cancelled before the answer arrived');
          if (a.answer !== null) { if (a.answer === b.answer) return json(res, 200, { ok: true }); throw new HttpError(409, 'this question has already been answered'); }
          if (!a.freeText && !a.choices.includes(b.answer)) throw new HttpError(400, 'answer must be one of the offered choices');
          a.answer = b.answer; bus.emit('ask-done', { id: a.id }); setTimeout(() => asks.delete(a.id), 60000).unref();
          return json(res, 200, { ok: true });
        }
        if (m === 'DELETE' && !g[2]) { asks.delete(a.id); bus.emit('ask-done', { id: a.id }); return json(res, 200, { ok: true }); }
      }
      if (p === '/api/schedules') {
        if (m === 'GET') return json(res, 200, schedules.status());
        if (m === 'PUT') {
          const body = await readJson(req); const r = checkSchedules(body);
          if (r.errors.length) throw new HttpError(400, r.errors.join('; '));
          atomicWrite(l.schedules, `${JSON.stringify(body, null, 2)}\n`); schedules.load(); return json(res, 200, schedules.status());
        }
      }
      if (p === '/api/bookmarks') {
        // bookmarks (Emacs): named files or folders. The kind is looked up when listing, so a moved path shows as missing, not as an error.
        let list = []; try { const v = JSON.parse(fs.readFileSync(l.bookmarks, 'utf8')); if (Array.isArray(v)) list = v.filter((b) => b && typeof b.name === 'string' && typeof b.path === 'string'); } catch { /* none or broken: empty */ }
        if (m === 'GET') return json(res, 200, list.map((b) => { let kind = 'missing'; try { kind = fs.statSync(b.path).isDirectory() ? 'dir' : 'file'; } catch { /* gone */ } return { name: b.name, path: b.path, kind }; }));
        if (m === 'PUT') {
          const body = await readJson(req); if (!Array.isArray(body)) throw new HttpError(400, 'bookmarks must be an array of {name, path}');
          const clean = body.filter((b) => b && typeof b.name === 'string' && b.name.trim() && typeof b.path === 'string' && path.isAbsolute(b.path)).map((b) => ({ name: b.name.trim().slice(0, 60), path: path.resolve(b.path) }));
          atomicWrite(l.bookmarks, `${JSON.stringify(clean, null, 2)}\n`); return json(res, 200, clean);
        }
      }
      if (p === '/api/commands') {
        // saved commands: [{name, text, enter}] typed into the terminal from the palette (like VS Code tasks)
        if (m === 'GET') return json(res, 200, readCommands());
        if (m === 'PUT') {
          const body = await readJson(req);
          if (!Array.isArray(body)) throw new HttpError(400, 'commands must be a JSON array of {name, text, enter?}');
          const clean = body.map((c) => ({ name: String(c?.name ?? '').trim(), text: String(c?.text ?? ''), enter: c?.enter !== false, ...(c?.paste === true && { paste: true }) })).filter((c) => c.name && c.text);
          atomicWrite(l.commands, `${JSON.stringify(clean, null, 2)}\n`);
          return json(res, 200, clean);
        }
      }
      if (p === '/api/watches') {
        // watches: notify on output patterns or idle time; see src/watches.js
        if (m === 'GET') { try { return json(res, 200, fs.existsSync(l.watches) ? JSON.parse(fs.readFileSync(l.watches, 'utf8')) : []); } catch { return json(res, 200, []); } }
        if (m === 'PUT') {
          const body = await readJson(req); const r = checkWatches(body);
          if (r.errors.length) throw new HttpError(400, r.errors.join('; '));
          atomicWrite(l.watches, `${JSON.stringify(body, null, 2)}\n`); watches.load();
          return json(res, 200, body);
        }
      }
      if (p === '/api/notify' && m === 'POST') {
        const b = await readJson(req);
        if (typeof b.text !== 'string' || !b.text) throw new HttpError(400, 'notify needs text');
        bus.emit('notify', { text: b.text.slice(0, 500), level: ['info', 'warn', 'done'].includes(b.level) ? b.level : 'info' });
        return json(res, 200, { ok: true });
      }

      if (p === '/api/widgets' && m === 'GET') return json(res, 200, state.widgetNames().map((name) => ({ name, ...state.widgetMeta(name), open: !!state.getPanel(`w-${name}`) })));
      if ((g = /^\/api\/widgets\/([\w-]+)$/.exec(p))) {
        if (m === 'PUT') { putWidget(g[1], await readJson(req, 4 * 1024 * 1024)); return json(res, 200, { ok: true }); }
        if (m === 'DELETE') {
          if (state.getPanel(`w-${g[1]}`)) state.deletePanel(`w-${g[1]}`, { trash: false });
          fs.rmSync(path.join(l.widgets, g[1]), { recursive: true, force: true }); state.rescan(); return json(res, 200, { ok: true });
        }
      }
      if ((g = /^\/api\/widgets\/([\w-]+)\/reload$/.exec(p)) && m === 'POST') { if (!state.bumpWidget(g[1])) throw new HttpError(404, `no widget ${g[1]}`); return json(res, 200, { ok: true }); }
      if ((g = /^\/api\/source\/([\w-]+)\/([\w-]+)$/.exec(p)) && m === 'GET') {
        const def = widgetSource(g[1], g[2]);
        return sse(req, res, (fn) => sources.subscribe(def, fn));
      }
      throw new HttpError(404, `no such API route: ${m} ${p}`);
    }

    // ---- user customisation (init.el idea): state-dir custom.css / custom.js, loaded by the page when present ----
    if ((g = /^\/custom\/(custom\.css|custom\.js)$/.exec(p)) && (m === 'GET' || m === 'HEAD')) {
      const f = path.join(stateDir, g[1]);
      if (!fs.existsSync(f)) throw new HttpError(404, `no ${g[1]} in the state dir (optional)`);
      return serveFile(res, f, { 'cache-control': 'no-cache' }, req);
    }

    if (p === '/background/image' && (m === 'GET' || m === 'HEAD')) {
      const b = findBackground(stateDir);
      if (!b.name) throw new HttpError(404, 'no background set; run `hatch set background IMAGE`');
      return serveImage(res, path.join(stateDir, b.name));
    }

    // ---- files ----
    if ((g = /^\/files\/uploads\/([\w.-]+)$/.exec(p))) {
      const f = inside(l.uploads, g[1]);
      if (!f) throw new HttpError(404, 'not found');
      return serveImage(res, f);
    }
    if (m !== 'GET' && m !== 'HEAD') throw new HttpError(405, 'method not allowed');
    const f = inside(PUBLIC, p === '/' ? 'index.html' : safeDecode(p.slice(1)));
    if (!f) throw new HttpError(404, 'not found');
    return serveFile(res, f, path.extname(f) === '.html' ? { 'content-security-policy': PAGE_CSP, 'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'no-referrer' } : {}, req);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host, allowedHosts)) throw new HttpError(403, hostRefusedMessage(req.headers.host));
      await route(req, res, new URL(req.url, 'http://x'));
    } catch (e) {
      const status = e.status || (e instanceof TerminalError ? 400 : 500);
      if (status === 500) log(`500 ${req.method} ${req.url}: ${e.stack || e}`);
      if (res.headersSent) return res.end();
      json(res, status, { error: e.message });
    }
  });

  // WebSocket upgrades are only accepted for the proxy, with the same Host and token checks as everything else.
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x'); let prox = parseProxyPath(u.pathname);
    if (prox) prox = { ...prox, rest: prox.rest + u.search };
    if (!prox || !hostAllowed(req.headers.host, allowedHosts) || viewOnly || levelOf(req) !== 'full' || prox.port === server.address()?.port) { socket.on('error', () => {}); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    proxyUpgrade(req, socket, head, prox);
  });

  return {
    viewOnly, server, state, term, bus, sources, token: cfg.token, session: cfg.session, config: cfg,
    async listen(at = port) { // `at` lets the caller retry on another port after EADDRINUSE; the same server object can listen again
      await new Promise((resolve, reject) => { const fail = (e) => { server.off('listening', resolve); reject(e); }; server.once('error', fail); server.listen(at, host, () => { server.off('error', fail); resolve(); }); });
      const actual = server.address().port;
      saveConfig(stateDir, { ...cfg, port: actual, host });
      cfg.port = actual;
      state.start();
      log(`hatch ${VERSION} listening on ${host}:${actual} (tmux session ${cfg.session}, state ${stateDir})`); // also makes sure the log exists for the log-tail widget
      term.setEnv?.({ HATCH_URL: `http://127.0.0.1:${actual}`, HATCH_STATE: stateDir });
      return actual;
    },
    async close() { gitClient.close(); clearInterval(viewWatch); schedules.close(); for (const t of extra.values()) t.stop(); for (const s of subs.values()) s.off(); runs.close(); watches.close(); sources.closeAll(); state.close(); bus.close(); term.stop(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); },
    baseUrl,
  };
}
