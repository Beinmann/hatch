// Page glue: events (SSE snapshot + updates), the terminal, windows, image paste/drop, notifications, settings.
import { el, isViewOnly } from './util.js';
import { initTerminal } from './terminal.js';
import { createWindows } from './windows.js';
import { createDockStrip } from './dock-strip.js';
import image from './panels/image.js';
import iframe from './panels/iframe.js';
import page from './panels/page.js';
import note from './panels/note.js';
import { createFx } from './fx.js';
import progress, { progressSummary } from './panels/progress.js';
import widget from './panels/widget.js';
import files from './panels/files.js';
import editor from './panels/editor.js';
import output from './panels/output.js';
import terminalPanel from './panels/terminal.js';
import gitPanel from './panels/git.js';
import trashPanel from './panels/trash.js';
import { initLimits } from './limits.js';
import { createPalette } from './palette.js';
import { calc, formatResult } from './calc.js';
import { createPeek, DEFAULT_PEEK, peekKeyOrNull } from './peek.js';
import { DEFAULT_LEADER, REPEAT_MS, parseChord, chordMatches, leaderAction, isEnter, isPaletteKey, isTermKey, isPrefixKey, isTextTarget } from './leader.js';

const $ = (id) => document.getElementById(id);

async function api(method, url, body, { signal } = {}) {
  if (isViewOnly() && !['GET', 'HEAD'].includes(method) && !(method === 'POST' && ['/api/sub', '/api/clientlog'].includes(url))) throw new Error('This link is view-only; use the full URL to make changes');
  // windows created from this page open in the workspace being shown
  if (method === 'POST' && url === '/api/panels' && body && body.ws === undefined && window.hatchApp?.wm.current() !== 'main') body = { ...body, ws: window.hatchApp.wm.current() };
  const res = await fetch(url, { method, signal, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = text; try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(data?.error || `${method} ${url}: ${res.status}`);
  return data;
}

// ---- settings (per browser) ----
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(`hatch.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`hatch.${k}`, JSON.stringify(v)); } catch { /* blocked */ } },
};

// ---- transparency (state dir transparency.json, percent 0..100): --opa is how opaque the backgrounds stay ----
const applyTransparency = (pct) => { const r = document.documentElement; const n = Number.isFinite(pct) ? pct : 30; r.style.setProperty('--opa', `${100 - n}%`); r.classList.add('has-tr'); term?.retheme?.(); }; // always on: 0 = fully opaque even with a background image set
// ---- background effect (state dir fx.json; pushed in the snapshot and by the 'fx' event; drawn by public/fx.js) ----
let fxs = {}; // workspace name -> { effect, intensity }; each workspace has its own effect
const fxOf = () => fxs[wm.current()] || { effect: null, intensity: 50 };
const applyFx = () => { const f = fxOf(); fxCtl.set(f.effect, f.intensity); };
const fxCtl = createFx({ canvas: $('fx'), getXterm: () => term?.term || null, onChange: (name) => { const b = $('fxhint'); b.hidden = !name; b.textContent = name ? 'fx: hatch fx off' : ''; } });
$('fxhint').addEventListener('click', () => api('POST', '/api/fx', { effect: 'off', ws: wm.current() }).catch((e) => toast(e.message, 'bad')));
// ---- background image (state dir background.*; the server sends its URL in the snapshot and on change) ----
const applyBackground = (b) => { const r = document.documentElement; if (b?.url) { r.style.setProperty('--bg-image', `url("${b.url}")`); r.dataset.bgmode = b.mode || 'fill'; r.classList.add('has-bg'); } else { r.style.removeProperty('--bg-image'); delete r.dataset.bgmode; r.classList.remove('has-bg'); } term?.retheme?.(); };

let backgrounds = {}; // workspace name -> { url, mode }; each workspace shows its own
const setBackgrounds = (b) => { backgrounds = b; applyBackground(backgrounds[wm.current()]); };

// ---- toasts + notifications ----
function toast(text, level = 'info', ms = 4500) {
  const t = el('div', { class: `toast ${level}`, role: 'status' }, text);
  $('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}
let blink = null;
const baseTitle = document.title;
function beep() {
  try {
    const a = new AudioContext(); const o = a.createOscillator(); const g = a.createGain();
    o.connect(g); g.connect(a.destination); g.gain.value = 0.05; o.frequency.value = 660; o.start(); o.stop(a.currentTime + 0.15);
  } catch { /* no audio */ }
}
function notify({ text, level }) {
  { const list = store.get('log', []); list.unshift({ t: Date.now(), text, level }); store.set('log', list.slice(0, 100)); } // *Messages*: kept per browser
  toast(text, level === 'warn' ? 'warn' : level === 'done' ? 'done' : 'info', 9000);
  if (document.hidden) {
    // Desktop notifications can be blocked on plain http over a LAN address, so the title blink is the fallback.
    clearInterval(blink);
    let on = false;
    blink = setInterval(() => { document.title = (on = !on) ? `* ${text.slice(0, 40)}` : baseTitle; }, 900);
    const stop = () => { clearInterval(blink); document.title = baseTitle; document.removeEventListener('visibilitychange', stop); };
    document.addEventListener('visibilitychange', stop);
    try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('Hatch', { body: text }); } catch { /* blocked */ }
  }
  if (store.get('sound', false)) beep();
}

// `hatch host`: open the page at this browser's own origin (works behind a reverse proxy; the login cookie is what authorises it).
// Every connected tab gets the event; they agree through localStorage which one acts (a visible tab first), so one browser opens one page.
// A pop-up without a user click is often blocked: then a toast stays until you click its link (a click is allowed to open a window).
function openHosted({ path: p, id }) {
  const url = location.origin + p;
  const claim = () => { try { if (localStorage.getItem('hatch-host-claimed') === id) return false; localStorage.setItem('hatch-host-claimed', id); } catch { /* no storage: every tab opens it */ } return true; };
  setTimeout(() => {
    if (!claim()) return;
    let w = null; try { w = window.open(url, '_blank'); } catch { /* blocked */ }
    if (w) return;
    const a = el('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open hosted page');
    const t = el('div', { class: 'toast info', role: 'status' }, 'The browser blocked the new window: ', a);
    a.addEventListener('click', () => setTimeout(() => t.remove(), 0)); // after the link has been followed
    $('toasts').append(t);
  }, document.hidden ? 400 : 0);
}

// ---- state mirrored from the server ----
const widgets = new Map();
let info = {};
let progressState = { diagram: '', steps: [] };
const plansState = new Map(); // named plans: name -> { diagram, steps }
const planListeners = new Set();
const progressListeners = new Set();
const panelListeners = new Set();
const warnings = new Map();

// One multiplexed connection for widget data: sources are subscribed over POST and arrive as `source` events.
const cid = Math.random().toString(36).slice(2) + Date.now().toString(36);
const srcHandlers = new Map(); // "widget/source" -> Set of callbacks
const srcKey = (w, s) => `${w}/${s}`;
function subscribeSource(widget, source, fn) {
  const key = srcKey(widget, source); let set = srcHandlers.get(key);
  if (!set) { set = new Set(); srcHandlers.set(key, set); }
  set.add(fn);
  if (set.size === 1) api('POST', '/api/sub', { cid, widget, source }).catch(() => {});
  return () => { set.delete(fn); if (!set.size) { srcHandlers.delete(key); api('POST', '/api/sub', { cid, widget, source, on: false }).catch(() => {}); } };
}

const screenshotters = new Map(); // panel id -> capture(opts) of an open widget window (see panels/widget.js)
// The server asked this tab for a PNG of a widget window; the answer (or the reason it failed) goes back over a POST.
async function answerScreenshot(d) {
  const reply = (body) => api('POST', `/api/screenshot/${d.id}`, body).catch((e) => toast(`screenshot not delivered: ${e.message}`, 'bad'));
  const cap = screenshotters.get(d.panel);
  if (!cap) return reply({ error: 'that window is not open in this tab (is it in another workspace?)' });
  try {
    const r = await cap({ abstract: d.abstract, scale: d.scale });
    const bytes = new Uint8Array(await r.png.arrayBuffer()); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await reply({ png: btoa(bin), width: r.width, height: r.height });
  } catch (e) { await reply({ error: e.message }); }
}

const ctx = {
  registerScreenshot: (id, fn) => { screenshotters.set(id, fn); return () => { if (screenshotters.get(id) === fn) screenshotters.delete(id); }; },
  typePath: (p) => typePath(p),
  uploadImage: (blob, name) => uploadImage(blob, name),
  openFile: (p, line) => term.openFileHook?.(p, line),
  subscribeSource,
  callSource: (widget, source, arg) => api('POST', '/api/call', { widget, source, ...(arg !== undefined && { arg }) }).then((r) => r.value),
  api, toast, cwd: () => info.cwd || '/', uploadsDir: () => info.uploadsDir, term: null, patch: (id, body) => api('PATCH', `/api/panels/${id}`, body),
  widgetInfo: (name) => widgets.get(name),
  progress: () => progressState,
  plan: (name) => plansState.get(name) || { diagram: '', steps: [] },
  onPlan: (fn) => { planListeners.add(fn); return () => planListeners.delete(fn); }, // fn(name, plan)
  onPanelEvent: (fn) => { panelListeners.add(fn); return () => panelListeners.delete(fn); },
  onProgress: (fn) => { progressListeners.add(fn); return () => progressListeners.delete(fn); },
};

// Progress stays out of the terminal until requested; opening its details uses a floating window.
let progressVisible = store.get('progress-visible', false);
function openProgress() {
  return api('POST', '/api/panels', { type: 'progress', title: 'Progress', placement: 'float', minimized: false }).catch((e) => toast(e.message, 'bad'));
}
function paintProgressStrip() {
  const { done, skipped, total, current, percent } = progressSummary(progressState.steps);
  $('progress-strip').hidden = !progressVisible;
  $('progressbtn').setAttribute('aria-expanded', String(progressVisible));
  $('progressbtn').classList.toggle('active', progressVisible);
  const segments = el('div', { class: 'strip-segments', 'aria-hidden': 'true' }, ...progressState.steps.map((s) => el('span', { class: s.status, title: `${s.title}: ${s.status}` })));
  $('progress-strip').replaceChildren(el('button', { type: 'button', class: 'strip-open', onclick: openProgress, title: 'Open progress details' },
    el('span', { class: 'strip-label' }, current?.status === 'blocked' ? 'Blocked' : current?.status === 'running' ? 'Now' : total && !current ? 'Complete' : 'Next'),
    el('span', { class: 'strip-title' }, current?.title || (total ? 'All steps finished' : 'No plan yet — open progress to get started')),
    segments, el('span', { class: 'muted small' }, `${done + skipped}/${total} · ${percent}%`)),
    el('button', { type: 'button', title: 'Fold progress strip (Ctrl+Shift+G)', 'aria-label': 'Fold progress strip', onclick: toggleProgress }, '⌃'));
}
function toggleProgress() { progressVisible = !progressVisible; store.set('progress-visible', progressVisible); paintProgressStrip(); }
$('progressbtn').addEventListener('click', toggleProgress);
progressListeners.add(paintProgressStrip);
paintProgressStrip();

const dockEl = $('dock'); const splitEl = $('split'); const stripEl = $('dockstrip');
createDockStrip({ dock: dockEl, strip: stripEl });
let dockWanted = store.get('dock-visible', false);
const wm = createWindows({
  floats: $('floats'), dock: dockEl, split: splitEl, chips: $('chips'), el,
  patch: ctx.patch, close: (id) => api('DELETE', `/api/panels/${id}`).catch((e) => toast(e.message, 'bad')),
  kinds: { image, iframe, page, note, progress, widget, files, editor, output, terminal: terminalPanel, git: gitPanel, trash: trashPanel }, ctx,
  dockOpen: () => dockWanted, openDock: () => { if (!dockWanted) { dockWanted = true; store.set('dock-visible', true); } },
  onDockChange: (any) => { $('dockbtn').hidden = !any; dockEl.hidden = splitEl.hidden = stripEl.hidden = !(any && dockWanted); requestAnimationFrame(() => wm.refit()); }, // the floating area changed width: refit now, not only when the resize observer fires
});
addEventListener('beforeunload', (e) => { if (wm.hasUnsavedChanges()) { e.preventDefault(); e.returnValue = ''; } });
ctx.focusPanel = (id, keyboard = true) => wm.focusPanel(id, keyboard);
// A focused widget frame cannot deliver keys to the page, so its SDK forwards Ctrl+Shift+G, Ctrl+Shift+P and the leader key plus the key after it.
// Returns whether the leader is armed, which the widget needs to know to keep forwarding.
ctx.leaderChord = () => leaderChord;
ctx.shortcut = (m) => {
  const key = { code: String(m.code || ''), key: String(m.key || ''), ctrlKey: m.ctrlKey === true, shiftKey: m.shiftKey === true, altKey: m.altKey === true, metaKey: m.metaKey === true };
  const fold = (key.ctrlKey && key.shiftKey && !key.altKey && !key.metaKey && key.code === 'KeyG') || isPaletteKey(key) || isTermKey(key) || isPrefixKey(key);
  // Only the leader chord or, once armed, the next key gets through; anything else a widget posts is ignored.
  if (fold || leader.armed || chordMatches(leaderChord, key)) window.dispatchEvent(new KeyboardEvent('keydown', { ...key, cancelable: true }));
  return leader.armed;
};
// Show or hide the dock column. Independent of Zen mode, which hides it with CSS only: dockWanted is untouched there, so the dock
// comes back as it was (open or closed) when Zen ends.
function toggleDock() {
  dockWanted = !dockWanted; store.set('dock-visible', dockWanted); wm.refresh();
  if (document.body.classList.contains('zen')) toast(`Dock ${dockWanted ? 'will show' : 'stays hidden'} when Zen mode ends`, 'info', 1800);
}
$('dockbtn').addEventListener('click', toggleDock);

function paintWarnings() {
  const list = [...warnings];
  $('warnbtn').hidden = !list.length;
  $('warnbtn').textContent = `${list.length} warning${list.length === 1 ? '' : 's'}`;
  $('warnlist').replaceChildren(...list.map(([file, msg]) => el('div', { class: 'w' }, `${file}: ${msg}`)));
  if (!list.length) $('warnlist').hidden = true;
}
$('warnbtn').addEventListener('click', () => { $('warnlist').hidden = !$('warnlist').hidden; });
$('setbtn').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; });

function connectEvents() {
  const es = new EventSource(`/api/events?cid=${cid}`);
  es.addEventListener('source', (e) => { const d = JSON.parse(e.data); for (const fn of srcHandlers.get(srcKey(d.widget, d.source)) || []) fn(d.value, d.ts); });
  es.addEventListener('snapshot', (e) => {
    for (const k of srcHandlers.keys()) { const [widget, ...rest] = k.split('/'); api('POST', '/api/sub', { cid, widget, source: rest.join('/') }).catch(() => {}); } // after a reconnect or server restart
    const s = JSON.parse(e.data);
    document.body.classList.toggle('viewonly', !!s.info.viewOnly);
    pendingAsks.length = 0; pendingAsks.push(...(s.asks || []));
    for (const id of askDrafts.keys()) if (!pendingAsks.some((question) => question.id === id)) askDrafts.delete(id);
    showAsk();
    gotSnapshot = true; if (s.info.viewOnly) { document.body.classList.add('viewonly'); $('conn').title = 'view-only mirror'; } loadCustom(s.info.custom); info = s.info; $('session').textContent = `tmux: ${s.info.session}`;
    setBackgrounds(s.backgrounds || {}); setWorkspaces(s.workspaces || [{ name: 'main', id: 'main' }]); presenceCounts = s.presence || {}; paintPresence(); applyTransparency(s.transparency); wm.setDefaultTransparency(s.windowTransparency); fxs = { ...(s.fxs || (s.fx?.effect ? { main: s.fx } : {})) }; applyFx();
    widgets.clear(); for (const w of s.widgets) widgets.set(w.name, w);
    progressState = s.progress; for (const f of progressListeners) f(progressState);
    plansState.clear(); for (const [n, v] of Object.entries(s.plans || {})) plansState.set(n, v); for (const [n, v] of plansState) for (const f of planListeners) f(n, v);
    warnings.clear(); for (const w of s.warnings) warnings.set(w.file, w.message);
    paintWarnings();
    const ids = new Set(s.panels.map((p) => p.id));
    for (const p of wm.all()) if (!ids.has(p.id)) wm.remove(p.id);
    for (const p of s.panels) wm.upsert(p);
    routeOnce();
    reportPresence();
  });
  es.addEventListener('transparency', (e) => { const d = JSON.parse(e.data); applyTransparency(d.transparency); wm.setDefaultTransparency(d.windowTransparency); });
  es.addEventListener('fx', (e) => { const d = JSON.parse(e.data); if (d.effect) fxs[d.ws || 'main'] = { effect: d.effect, intensity: d.intensity }; else delete fxs[d.ws || 'main']; applyFx(); });
  es.addEventListener('background', (e) => { const d = JSON.parse(e.data); if (d.background) backgrounds[d.ws || 'main'] = d.background; else delete backgrounds[d.ws || 'main']; applyBackground(backgrounds[wm.current()]); });
  es.addEventListener('workspaces', (e) => setWorkspaces(JSON.parse(e.data).workspaces));
  es.addEventListener('presence', (e) => { presenceCounts = JSON.parse(e.data).counts || {}; paintPresence(); });
  es.addEventListener('activity', (e) => noteActivityEvent(JSON.parse(e.data).terminal));
  es.addEventListener('panel', (e) => { const d = JSON.parse(e.data); for (const f of panelListeners) f(d); if (d.action === 'removed') wm.remove(d.panel.id); else { if (d.action === 'created' && d.panel.type === 'editor') remember('recent', d.panel.props.path, 15); wm.upsert(d.panel); if (d.action === 'created') wm.revealDock(d.panel.id); } });
  es.addEventListener('progress', (e) => { progressState = JSON.parse(e.data); window.hatchUI?.emit('progress', progressState); for (const f of progressListeners) f(progressState); });
  es.addEventListener('plan', (e) => { const d = JSON.parse(e.data); if (d.removed) plansState.delete(d.name); else plansState.set(d.name, { diagram: d.diagram, steps: d.steps }); for (const f of planListeners) f(d.name, plansState.get(d.name) || { diagram: '', steps: [] }); });
  es.addEventListener('widget', (e) => {
    const d = JSON.parse(e.data);
    if (d.removed) widgets.delete(d.name); else widgets.set(d.name, d);
    wm.widgetChanged(d);
  });
  es.addEventListener('screenshot', (e) => answerScreenshot(JSON.parse(e.data)));
  es.addEventListener('ask', (e) => { pendingAsks.push(JSON.parse(e.data)); if (pendingAsks.length === 1) showAsk(); });
  es.addEventListener('ask-done', (e) => dropAsk(JSON.parse(e.data).id));
  es.addEventListener('copy', (e) => { const d = JSON.parse(e.data); clipboardIn(d.text, d.label); });
  es.addEventListener('notify', (e) => { const d = JSON.parse(e.data); window.hatchUI?.emit('notify', d); notify(d); });
  es.addEventListener('open-hosted', (e) => openHosted(JSON.parse(e.data)));
  es.addEventListener('warning', (e) => { const d = JSON.parse(e.data); if (d.message === null) warnings.delete(d.file); else warnings.set(d.file, d.message); paintWarnings(); });
}

// ---- questions from Claude (hatch ask): a dialog, one at a time, queued ----
const pendingAsks = []; const askDrafts = new Map(); const answeringAsks = new Set();
function showAsk() {
  const a = pendingAsks[0]; $('askbox').hidden = !a;
  if (!a) return term.focus();
  $('askq').textContent = a.question;
  const answer = async (v) => {
    if (isViewOnly() || answeringAsks.has(a.id)) return;
    answeringAsks.add(a.id); controls();
    try { await api('POST', `/api/ask/${a.id}/answer`, { answer: v }); dropAsk(a.id); }
    catch (e) { if (pendingAsks.some((question) => question.id === a.id)) toast(e.message, 'bad'); }
    finally { answeringAsks.delete(a.id); if (pendingAsks[0]?.id === a.id) controls(); }
  };
  const txt = $('asktext'); txt.hidden = !a.freeText; txt.value = askDrafts.get(a.id) || '';
  txt.oninput = () => askDrafts.set(a.id, txt.value);
  $('askbtns').replaceChildren(...a.choices.map((c) => el('button', { type: 'button', onclick: () => answer(c) }, c)),
    ...(a.freeText ? [el('button', { type: 'button', onclick: () => answer(txt.value) }, 'Send')] : []));
  function controls() { const disabled = isViewOnly() || answeringAsks.has(a.id); txt.disabled = disabled; for (const button of $('askbtns').querySelectorAll('button')) button.disabled = disabled; }
  controls();
  txt.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') answer(txt.value); };
  if (!isViewOnly()) (a.freeText ? txt : $('askbtns').firstChild)?.focus();
}
const dropAsk = (id) => { const i = pendingAsks.findIndex((a) => a.id === id); if (i >= 0) { pendingAsks.splice(i, 1); askDrafts.delete(id); if (i === 0) showAsk(); } };

// ---- clipboard bridge: text from the box (hatch copy, terminal OSC 52) to this browser's clipboard ----
// Browsers only allow clipboard writes after a user gesture, so when the direct write fails a toast with a Copy button is shown.
async function clipboardIn(text, label) {
  if (typeof text !== 'string' || !text) return;
  remember('clips', text.slice(0, 2000), 20);
  try { await navigator.clipboard.writeText(text); toast(`Copied ${text.length} characters from the box${label ? ` (${label})` : ''}`); return; } catch { /* needs a click */ }
  const t = el('div', { class: 'toast warn', role: 'status' }, `The box wants to copy ${text.length} characters${label ? ` (${label})` : ''}: `,
    el('button', { type: 'button', onclick: async () => { const { copyText } = await import('./terminal.js'); toast((await copyText(text)) ? 'Copied' : 'Copy failed', 'info'); t.remove(); } }, 'Copy'));
  $('toasts').append(t); setTimeout(() => t.remove(), 30000);
}

// ---- terminal ----
const conn = $('conn');
// One terminal per workspace, created the first time the workspace is shown and kept connected afterwards (switching only
// shows another one; the programs run in tmux either way). `term` stays one stable object that forwards to the shown one.
let wsList = [{ name: 'main', id: 'main' }]; // workspaces [{ name, id }] from the server
const terms = new Map(); // workspace name -> { host, id, ctl, status, rc }
let activeTerm = null;
const term = new Proxy({}, { get: (_, k) => activeTerm?.[k], set: (_, k, v) => { if (activeTerm) activeTerm[k] = v; return true; } });
const bellOnce = (() => { let last = 0; return () => { if (document.hidden && Date.now() - last > 10000) { last = Date.now(); notify({ text: 'Terminal bell', level: 'info' }); } }; })(); // a finished job that rings pings you when the tab is in the background; at most once per 10 s
const paintStatus = (s) => { conn.textContent = s || ''; conn.className = `chip ${s === 'connected' ? 'ok' : s === 'connecting' ? '' : 'bad'}`; };
const paintReconnect = (msg) => { $('reconnect').hidden = !msg; if (msg) $('rcmsg').textContent = msg; };
function makeTerm(w) {
  const host = el('div', { class: 'termhost' }); $('term').append(host);
  const e = { host, id: w.id, ctl: null, status: 'connecting', rc: null, live: false };
  const shown = () => terms.get(wm.current()) === e;
  e.ctl = initTerminal({
    host, api, toast, base: w.name === 'main' ? '/api/term' : `/api/pterm/ws-${w.id}`, onCopy: (t) => { if (t && t.trim()) remember('clips', t.slice(0, 2000), 20); },
    onBell: () => { bellOnce(); if (!shown()) markAttention(w.name); },
    onOpenFile: async (p, line) => { try { const r = await api('GET', `/api/fs/resolve?path=${encodeURIComponent(p)}`); await api('POST', '/api/panels', { type: 'editor', title: r.path.split('/').pop(), props: { path: r.path, line } }); } catch (x) { toast(x.message, 'warn', 7000); } },
    onClipboard: (t) => clipboardIn(t, 'terminal'), fontSize: store.get('fontSize', 14), onFontSize: (n) => store.set('fontSize', n),
    onStatus: (s) => { e.status = s; if (shown()) paintStatus(s); },
    reconnectUi: (msg) => { e.rc = msg; if (shown()) paintReconnect(msg); },
    // Ctrl+Shift+F/Z/G/1..9 stay with the page (the leader key is handled before xterm sees it); Ctrl+B etc. all go to tmux.
    shortcuts: (ev) => (isPaletteKey(ev) ? (ev.preventDefault(), true) : ev.ctrlKey && ev.shiftKey && (['KeyF', 'KeyZ', 'KeyG'].includes(ev.code) || /^Digit[1-9]$/.test(ev.code)) ? (ev.preventDefault(), true) : false),
  });
  return e;
}
/** Shows the terminal of workspace `name` (creating and connecting it the first time). */
function showTerm(name) {
  const w = wsList.find((x) => x.name === name) || { name, id: name };
  let e = terms.get(name);
  for (const [n, x] of terms) { x.host.hidden = n !== name; if (n !== name && x.live) { x.live = false; x.ctl.pause(); } } // the others keep running in tmux but hold no connection
  if (!e) { e = makeTerm(w); terms.set(name, e); }
  e.host.hidden = false; activeTerm = e.ctl;
  paintStatus(e.status); paintReconnect(e.rc);
  if (!e.live) { e.live = true; e.ctl.connect(); } else e.ctl.fit();
  if (fxCtl) applyFx(); // the effect canvas follows the shown terminal (and its workspace's effect)
}
showTerm('main'); // the other workspaces' terminals are made when first shown (the right one is chosen after the first snapshot)
ctx.term = term;
let termPointer = false; // a click already shows where you are; only flash for keyboard focus
$('term').addEventListener('pointerdown', () => { termPointer = true; setTimeout(() => { termPointer = false; }, 300); wm.blur(); });
// Switching back to the browser window re-fires focusin on the previously focused element (no relatedTarget); that is not keyboard focus arriving, so no flash.
let winFocusAt = 0;
addEventListener('focus', (e) => {
  if (e.target !== window) return;
  winFocusAt = Date.now();
  // Coming back to the tab: put the cursor in the terminal, but only when nothing specific had focus
  // (a popup, editor, input or widget frame keeps it, so we never steal typing from them).
  const a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) term.focus();
});
$('term').addEventListener('focusin', (e) => {
  wm.blur();
  if (Date.now() - winFocusAt < 150) return;
  // focusin also fires when focus moves inside #term; only flash when it arrives from outside
  if (termPointer || ($('term').contains(e.relatedTarget))) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const w = $('termwrap'); w.classList.remove('flash'); void w.offsetWidth; w.classList.add('flash');
});
$('termwrap').addEventListener('animationend', (e) => { if (e.target === e.currentTarget || e.target.id === 'termflash') e.currentTarget.classList.remove('flash'); });
term.openFileHook = (p, line) => (async () => { try { const r = await api('GET', `/api/fs/resolve?path=${encodeURIComponent(p)}`); await api('POST', '/api/panels', { type: 'editor', title: r.path.split('/').pop(), props: { path: r.path, line } }); } catch (e) { toast(e.message, 'warn', 7000); } })();
$('rcbtn').addEventListener('click', () => term.connect());

// ---- image paste and drop ----
async function uploadImage(blob, name) {
  try {
    const res = await fetch('/api/upload', { method: 'POST', headers: { 'x-filename': name || 'paste', 'content-type': blob.type || 'application/octet-stream' }, body: blob });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    typePath(d.path); // the absolute path on the box: that is what Claude reads
    toast(`Saved ${d.path.split('/').slice(-2).join('/')}`);
    if (store.get('openImage', false)) api('POST', '/api/panels', { type: 'image', title: d.name, props: { src: d.path } }).catch(() => {});
    term.focus();
    return d;
  } catch (e) { toast(`Upload failed: ${e.message}`, 'bad'); }
}
// Any other file (a log, a PDF, a zip): uploaded into the uploads dir under its own name (numbered if taken), path typed.
async function uploadFile(file) {
  const dir = info.uploadsDir; if (!dir) return toast('Upload directory unknown; reload the page', 'warn');
  const dot = file.name.lastIndexOf('.'); const stem = (dot > 0 ? file.name.slice(0, dot) : file.name) || 'file'; const ext = dot > 0 ? file.name.slice(dot) : '';
  for (let n = 1; n <= 50; n++) {
    const name = n === 1 ? `${stem}${ext}` : `${stem}-${n}${ext}`;
    const res = await fetch(`/api/fs/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, { method: 'POST', body: file });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { typePath(d.path); toast(`Saved ${name} (${(d.bytes / 1024).toFixed(0)} KB)`); term.focus(); return; }
    if (res.status !== 409) return toast(`Upload failed: ${d.error || res.status}`, 'bad');
  }
  toast('Too many files with that name', 'bad');
}
// Only intercept when an image is present: text paste must keep going to xterm. Uses the paste EVENT, which also
// works on plain http (navigator.clipboard.read needs a secure context).
document.addEventListener('paste', (e) => {
  if (isViewOnly()) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  const items = files.length ? files : [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
  if (!items.length) {
    const other = [...(e.clipboardData?.files || [])]; // a copied file (not text, not an image)
    if (other.length) { e.preventDefault(); e.stopPropagation(); other.forEach((f) => uploadFile(f)); return; }
    // nothing usable: say so, with what the browser did offer (Ctrl+Shift+V is "paste as plain text" and drops images in some browsers)
    const types = [...(e.clipboardData?.types || [])];
    if (!types.includes('text/plain')) toast(`Paste had no image or text (clipboard offered: ${types.join(', ') || 'nothing'}). Try Ctrl+V instead of Ctrl+Shift+V`, 'warn');
    return;
  }
  e.preventDefault(); e.stopPropagation();
  items.forEach((f) => uploadImage(f, f.name));
}, true);
const wrap = $('termwrap');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
wrap.addEventListener('dragenter', (e) => { if (!isViewOnly() && hasFiles(e)) { dragDepth++; $('dropmsg').hidden = false; } });
wrap.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropmsg').hidden = true; } });
wrap.addEventListener('dragover', (e) => { if (hasFiles(e) || [...(e.dataTransfer?.types || [])].includes('application/x-hatch-path')) e.preventDefault(); });
wrap.addEventListener('drop', (e) => {
  if (isViewOnly()) { e.preventDefault(); return; }
  const dragged = e.dataTransfer?.getData('application/x-hatch-path'); // a file row dragged from the files window
  if (dragged) { e.preventDefault(); dragDepth = 0; $('dropmsg').hidden = true; typePath(dragged); term.focus(); return; }
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('dropmsg').hidden = true;
  // dragging a path out of the files window types it; dropped images get the image treatment, other files are uploaded as they are
  const files = [...e.dataTransfer.files];
  files.forEach((f) => (f.type.startsWith('image/') ? uploadImage(f, f.name) : uploadFile(f)));
});

// ---- settings controls ----
$('optImage').checked = store.get('openImage', false);
$('optImage').addEventListener('change', (e) => store.set('openImage', e.target.checked));
$('optLeader').value = store.get('leader', DEFAULT_LEADER);
$('optLeader').addEventListener('change', (e) => {
  const v = e.target.value.trim() || DEFAULT_LEADER; const c = parseChord(v);
  if (!c) { toast(`"${v}" is not a leader key. Use modifiers plus a key, for example Ctrl+Space, Ctrl+A or Alt+Space`, 'warn', 7000); e.target.value = store.get('leader', DEFAULT_LEADER); return; }
  store.set('leader', v); leaderChord = c; e.target.value = v; toast(`Leader key is now ${v}`);
});
$('optSound').checked = store.get('sound', false);
$('optSound').addEventListener('change', (e) => store.set('sound', e.target.checked));
$('optNotify').addEventListener('click', async () => {
  if (typeof Notification === 'undefined') return toast('This browser has no desktop notifications here; toasts and the title blink still work', 'warn');
  try { const r = await Notification.requestPermission(); toast(r === 'granted' ? 'Desktop notifications on' : `Notifications ${r}; toasts and title blink still work`); } catch { toast('Notification permission is blocked here (plain http?)', 'warn'); }
});

// ---- find in scrollback (Ctrl+Shift+F) ----
const findbar = $('findbar'); const findq = $('findq');
function runFind(dir) { const r = term.find(findq.value, dir); $('findn').textContent = findq.value ? (r.found ? `${r.index}/${r.total}` : 'no match') : ''; }
function openFind() { findbar.hidden = false; findq.focus(); findq.select(); if (findq.value) runFind(1); }
function closeFind() { findbar.hidden = true; term.resetFind(); term.focus(); }
findq.addEventListener('input', () => { term.resetFind(); runFind(1); });
findq.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); runFind(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { e.preventDefault(); closeFind(); } });
$('findnext').addEventListener('click', () => runFind(1)); $('findprev').addEventListener('click', () => runFind(-1)); $('findx').addEventListener('click', closeFind);
addEventListener('keydown', (e) => { if (e.ctrlKey && e.shiftKey && e.code === 'KeyF') { e.preventDefault(); openFind(); } }, true);

// ---- workspaces: named sets of windows with their own terminal and background (registry on the server, see src/workspaces.js) ----
let presenceCounts = {}; // workspace -> number of open tabs showing it
const attention = new Set(); // other workspaces that rang a bell or printed a burst since you left them
let numbering = false; // leader w: chips show their number
const wsNames = () => { const n = wsList.map((w) => w.name); const cur = wm.current(); return n.includes(cur) ? n : [...n, cur]; };
function paintWorkspaces() {
  const cur = wm.current(); const names = wsNames();
  $('wsbar').replaceChildren(...names.map((n, i) => el('button', { type: 'button', class: `chip${n === cur ? ' on' : ''}${attention.has(n) ? ' attn' : ''}`, title: `Workspace ${n}${attention.has(n) ? ' (something happened there)' : ''}`, onclick: () => switchWs(n) }, numbering && i < 9 ? `${i + 1} ${n}` : n)),
    el('button', { type: 'button', class: 'chip', title: 'New workspace', onclick: () => newWorkspace() }, '+'));
  const label = $('wslabel'); if (label) { label.textContent = cur; label.title = 'Current workspace'; }
  document.title = cur === 'main' && names.length === 1 ? baseTitle : `${cur} · ${baseTitle}`;
}
const markAttention = (n) => { if (n !== wm.current() && !attention.has(n)) { attention.add(n); paintWorkspaces(); } };
function noteActivityEvent(name) {
  let ws = null;
  if (name === '@main') ws = 'main';
  else if (name?.startsWith('ws-')) ws = wsList.find((w) => w.id === name.slice(3))?.name;
  else { const p = wm.all().find((x) => x.type === 'terminal' && x.props.name === name); if (p && !p.sticky) ws = p.ws || 'main'; }
  if (ws) markAttention(ws);
}
function setWorkspaces(list) {
  // a rename changes the name but not the id: keep that workspace's terminal
  for (const [n, e] of [...terms]) {
    const now = list.find((w) => w.id === e.id);
    if (now && now.name !== n) { terms.delete(n); terms.set(now.name, e); if (store.get('ws', 'main') === n) store.set('ws', now.name); if (wm.current() === n) { wm.setWorkspace(now.name); setHash(now.name, true); } }
    else if (!now && n !== 'main') { e.ctl.close(); e.host.remove(); terms.delete(n); }
  }
  wsList = list;
  for (const n of [...attention]) if (!wsNames().includes(n)) attention.delete(n);
  if (routed && !list.some((w) => w.name === wm.current())) { toast(`Workspace ${wm.current()} was closed`, 'info', 3000); showWorkspace('main'); setHash('main', true); }
  applyFx(); // a rename or a closed workspace can change which effect the shown workspace has
  paintWorkspaces(); paintPresence();
}
/** Shows a workspace: its windows, terminal and background. Terminals of the others keep running. */
function showWorkspace(n) {
  wm.setWorkspace(n); store.set('ws', n); attention.delete(n);
  showTerm(n); applyBackground(backgrounds[n]); paintWorkspaces(); reportPresence();
  if (document.activeElement === document.body || !document.activeElement) term.focus();
}
const hashName = () => { try { return decodeURIComponent(location.hash.slice(1)); } catch { return ''; } };
function setHash(n, replace = false) { const h = `#${encodeURIComponent(n)}`; if (location.hash === h) return; if (replace) history.replaceState(null, '', h); else location.hash = h; }
/** Switching sets the URL hash; the hashchange handler shows it, so the address bar, back/forward and bookmarks all agree. */
function switchWs(n) { if (n === wm.current()) return; setHash(n); }
let routed = false;
async function routeTo(n, { initial = false } = {}) {
  if (wsList.some((w) => w.name === n)) { showWorkspace(n); return true; }
  const fallback = wsList.some((w) => w.name === store.get('ws', 'main')) ? store.get('ws', 'main') : 'main';
  if (n && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(n) && !isViewOnly()) {
    const go = await askBox({ title: `There is no workspace named ${n}`, text: 'Create it? It starts empty, with its own terminal.', ok: 'Create' });
    if (go) { try { await createWs(n); showWorkspace(n); return true; } catch (e) { toast(e.message, 'bad'); } }
  } else if (n) toast(`There is no workspace named ${n}`, 'warn', 4000);
  showWorkspace(fallback); setHash(fallback, true); return false;
}
async function routeOnce() { // after the first snapshot: the URL hash wins, else the last used workspace
  if (routed) return; routed = true;
  const h = hashName();
  if (h) await routeTo(h, { initial: true }); else { const last = store.get('ws', 'main'); showWorkspace(wsList.some((w) => w.name === last) ? last : 'main'); setHash(wm.current(), true); }
}
addEventListener('hashchange', () => { if (routed && hashName() !== wm.current()) routeTo(hashName()); });
async function createWs(name) { const w = await api('POST', '/api/workspaces', { name }); if (!wsList.some((x) => x.name === w.name)) setWorkspaces([...wsList, w]); return w; }
// tell the server which workspace this tab shows: another tab on the same one gets a notice (no locking, both stay live)
let reported = null;
function reportPresence() { const ws = wm.current(); if (!routed || isViewOnly() || reported === `${cid}:${ws}:${gotSnapshot}`) return; reported = `${cid}:${ws}:${gotSnapshot}`; api('POST', '/api/presence', { cid, ws }).catch(() => { reported = null; }); }
let noticeDismissed = null;
function paintPresence() {
  const n = $('wsnotice'); if (!n) return;
  const others = Math.max(0, (presenceCounts[wm.current()] || 0) - 1);
  const key = `${wm.current()}:${others}`;
  n.hidden = !others || noticeDismissed === key;
  n.textContent = others ? `also open in ${others > 1 ? `${others} other tabs` : 'another tab'}` : '';
  n.onclick = () => { noticeDismissed = key; n.hidden = true; };
  n.title = 'Both tabs show the same live windows and terminal. Click to hide this notice.';
}
const origUpsert = wm.upsert; wm.upsert = (p) => { origUpsert(p); paintWorkspaces(); };

// A small dialog: a question with optional typed answer. Resolves to the text (or true), or null when cancelled.
function askBox({ title, text = '', ok = 'OK', input = null, match = null, danger = false }) {
  return new Promise((resolve) => {
    const done = (v) => { box.remove(); resolve(v); term.focus(); };
    const field = input !== null ? el('input', { type: 'text', value: input.value || '', placeholder: input.placeholder || '', autocomplete: 'off', spellcheck: 'false', 'aria-label': title }) : null;
    const okBtn = el('button', { type: 'button', class: danger ? 'danger' : '', onclick: () => done(field ? field.value.trim() : true) }, ok);
    const sync = () => { okBtn.disabled = !!field && (match !== null ? field.value !== match : !field.value.trim()); };
    field?.addEventListener('input', sync);
    const box = el('div', { id: 'palette', onclick: (e) => { if (e.target === box) done(null); } }, el('div', { class: 'box pad', role: 'dialog', 'aria-label': title },
      el('h3', { style: 'margin:0 0 8px' }, title), text ? el('p', { class: 'muted' }, text) : '', field || '', el('div', { style: 'margin-top:10px;display:flex;gap:8px;justify-content:flex-end' }, el('button', { type: 'button', onclick: () => done(null) }, 'Cancel'), okBtn)));
    box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') done(null); else if (e.key === 'Enter' && !okBtn.disabled) { e.preventDefault(); okBtn.click(); } });
    sync(); document.body.append(box); const first = field || okBtn; first.focus(); setTimeout(() => { if (box.isConnected && !box.contains(document.activeElement)) first.focus(); }, 80); // a widget frame may grab focus as it loads
  });
}
// asks for a transparency percent (or "default" when allowDefault) in a box and hands the validated value to save()
async function askTransparency(title, text, save, allowDefault = false) {
  if (isViewOnly()) return;
  const raw = await askBox({ title, text, ok: 'Set', input: { placeholder: allowDefault ? '0-100 or default' : '0-100' } });
  if (raw === null) return;
  const v = allowDefault && raw === 'default' ? 'default' : Number(raw);
  if (v !== 'default' && !(/^\d{1,3}$/.test(raw) && v >= 0 && v <= 100)) return toast('Use a whole number from 0 to 100', 'bad');
  try { await save(v); } catch (e) { toast(e.message, 'bad'); }
}
async function newWorkspace() {
  if (isViewOnly()) return;
  const n = await askBox({ title: 'New workspace', text: 'Letters, digits, - and _ (up to 32). It gets its own terminal, windows and background.', ok: 'Create', input: { placeholder: 'name' } });
  if (!n) return;
  try { await createWs(n); switchWs(n); } catch (e) { toast(e.message, 'bad'); }
}
async function renameWorkspace() {
  const cur = wm.current();
  if (cur === 'main') return toast('main cannot be renamed; create another workspace instead', 'info');
  const n = await askBox({ title: `Rename workspace ${cur}`, ok: 'Rename', input: { value: cur } });
  if (!n || n === cur) return;
  try { await api('POST', `/api/workspaces/${encodeURIComponent(cur)}/rename`, { to: n }); } catch (e) { toast(e.message, 'bad'); }
}
async function closeWorkspace(name = wm.current()) {
  if (name === 'main') return toast('main is the default workspace and cannot be closed', 'info');
  const count = wm.all().filter((p) => (p.ws || 'main') === name).length;
  const typed = await askBox({ title: `Close workspace ${name}?`, text: `This closes its ${count} window${count === 1 ? '' : 's'} and ends its terminals for good. Type the workspace name to confirm.`, ok: 'Close workspace', input: { placeholder: name }, match: name, danger: true });
  if (typed !== name) return;
  try { await api('DELETE', `/api/workspaces/${encodeURIComponent(name)}`, { confirm: typed }); if (wm.current() === name) { showWorkspace('main'); setHash('main'); } toast(`Workspace ${name} closed`, 'info', 2500); } catch (e) { toast(e.message, 'bad'); }
}
// a one-off palette over a list of choices (the workspace and window pickers)
function pick(labels, onPick, hint = () => '') {
  const pal = createPalette({ initialEntries: () => labels.map((l) => ({ label: l.label ?? l, hint: hint(l), run: () => onPick(l) })), entries: async () => labels.map((l) => ({ label: l.label ?? l, hint: hint(l), run: () => onPick(l) })), onError: (e) => toast(e.message, 'bad') });
  pal.open();
}
const pickWorkspace = (onPick, { exclude = [] } = {}) => pick(wsNames().filter((n) => !exclude.includes(n)), onPick, (n) => `${wm.all().filter((p) => (p.ws || 'main') === n).length} windows${attention.has(n) ? ' · attention' : ''}${(presenceCounts[n] || 0) ? ' · open in a tab' : ''}`);
function moveWindowToWorkspace() {
  const go = (p) => pickWorkspace((n) => ctx.patch(p.id, { ws: n === 'main' ? 'main' : n }).then(() => toast(`Moved ${p.title} to ${n}`, 'info', 2000)).catch((e) => toast(e.message, 'bad')), { exclude: [p.ws || 'main'] });
  const f = wm.focusedPanel();
  if (f) return go(f);
  const here = wm.all().filter((p) => p.sticky || (p.ws || 'main') === wm.current());
  if (!here.length) return toast('No windows in this workspace', 'info', 1500);
  pick(here.map((p) => ({ label: `${p.title} (${p.id})`, p })), (x) => go(x.p), (x) => x.p.type);
}
function setWorkspaceBackground() {
  const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true });
  input.addEventListener('change', async () => {
    const f = input.files[0]; input.remove(); if (!f) return;
    try { const res = await fetch(`/api/workspaces/${encodeURIComponent(wm.current())}/background`, { method: 'PUT', body: f }); if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `upload failed (${res.status})`); toast(`Background set for ${wm.current()}`, 'info', 2000); } catch (e) { toast(e.message, 'bad'); }
  });
  document.body.append(input); input.click();
}

// ---- keyboard shortcuts overlay ----
const SHORTCUTS = [[`${store.get('leader', DEFAULT_LEADER)}, then ...`, 'Leader key. h j k l / arrows focus, 1-9 window by number, Tab next, t or Return terminal, q close, m minimize, Shift+d show desktop (minimize all; again to restore), d dock or release the focused window, u pick from the dock, s show or hide the dock, f maximize, a tile, p palette, ] or [ next or previous workspace, w then 1-9 jump to a workspace'], ['Leader, then o', 'Ask for the focused popup\'s transparency, 0-100 (0 = not transparent, capped at 80); kept per window'], ['Leader, then Shift+h j k l', 'Move the focused window (Ctrl+h j k l resizes it)'], ['Leader twice', 'Stays in leader mode'], ['Ctrl+Shift+G', 'Fold / unfold progress strip'], ['Ctrl+P (or leader, then p)', 'Command palette. Ctrl+Shift+P also works in Chrome; Firefox reserves it for a private window. Inside the palette Ctrl+P / Ctrl+N move the selection'], ['Hold Alt alone', 'Peek: hides the floating windows while held (dock, effects and background stay) (after about 0.2 s, so Alt+key chords do not flash); release brings everything back. Any other key ends it. Key is configurable in Settings'], ['Ctrl+Shift+F', 'Find in terminal scrollback'], ['Ctrl+Shift+Z', 'Zen mode (hide header and dock; the dock returns as it was)'], ['Ctrl+Shift+1 ... 9', 'Switch to the n-th workspace'], ['Ctrl+C (with selection)', 'Copy; without a selection it interrupts'], ['Shift+drag', 'Select text in a mouse-aware tmux'], ['Double-click a title bar', 'Maximize or restore a window'], ['Drag a docked window\'s title bar', 'Reorder the dock (Escape cancels)'], ['Double-click a note', 'Edit it (Ctrl+Enter saves)'], ['Ctrl+S in an editor window', 'Save the file'], ['Ctrl+Shift+Space', 'Focus the terminal from anywhere (windows, popups, editors, widgets; closes the palette)'], ['Ctrl+B (window focused)', 'Focus the terminal and send the tmux prefix (not in text fields; there Ctrl+B is the field\'s)'], ['Ctrl+B ...', 'tmux prefix: always goes to tmux']];
function showHelp() {
  const close = () => box.remove();
  const box = el('div', { id: 'palette', onclick: (e) => { if (e.target === box) close(); } }, el('div', { class: 'box pad' }, el('h3', { style: 'margin:0 0 8px' }, 'Keyboard shortcuts'),
    el('table', { class: 'keytab' }, ...SHORTCUTS.map(([k, d]) => el('tr', {}, el('td', {}, el('kbd', {}, k)), el('td', { class: 'muted' }, d)))), el('p', { class: 'muted small' }, 'Esc or click outside to close')));
  box.tabIndex = -1; box.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.append(box); box.focus();
}

// ---- notification log (Emacs *Messages*) ----
function showLog() {
  const close = () => box.remove(); const list = store.get('log', []);
  const box = el('div', { id: 'palette', onclick: (e) => { if (e.target === box) close(); } }, el('div', { class: 'box pad' },
    el('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, el('h3', { style: 'margin:0 0 8px' }, 'Notifications'), el('button', { type: 'button', onclick: () => { store.set('log', []); close(); } }, 'Clear')),
    list.length ? el('table', { class: 'keytab' }, ...list.slice(0, 40).map((n) => el('tr', {}, el('td', { class: 'muted small' }, new Date(n.t).toLocaleTimeString()), el('td', {}, el('span', { class: `chip ${n.level === 'warn' ? 'warn' : n.level === 'done' ? 'ok' : ''}` }, n.level || 'info')), el('td', {}, n.text)))) : el('p', { class: 'muted' }, 'Nothing yet.'),
    el('p', { class: 'muted small' }, 'Esc or click outside to close')));
  box.tabIndex = -1; box.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }); document.body.append(box); box.focus();
}

// ---- Zen mode (hide the header, hint and dock; VS Code zen idea) and workspace chords ----
function toggleZen() { document.body.classList.toggle('zen'); term.fit(); wm.refit(); term.focus(); if (document.body.classList.contains('zen')) toast('Zen mode: Ctrl+Shift+Z leaves it', 'info', 2500); }
// Ctrl+Shift+Space focuses the terminal from anywhere (closing the palette first). Ctrl+B with a window focused (not a text field)
// focuses the terminal and sends the tmux prefix; with the terminal focused it reaches tmux as before. Both work from widget frames via the SDK.
addEventListener('keydown', (e) => {
  if (e.isComposing || leader.armed) return;
  const termKey = isTermKey(e); const prefix = isPrefixKey(e);
  if (!termKey && !prefix) return;
  const a = document.activeElement;
  if (prefix && (isTextTarget(a) || isTextTarget(e.target) || a?.closest?.('#term, #palette') || !a?.closest?.('.win'))) return;
  if (isViewOnly()) return;
  e.preventDefault(); e.stopPropagation();
  if (palette.isOpen()) palette.close();
  wm.blur(); term.focus();
  if (prefix) term.type('\x02');
}, true);
addEventListener('keydown', (e) => {
  // Ctrl+P (also Ctrl+Shift+P) opens the palette from anywhere, the terminal included. Inside the palette Ctrl+P moves up.
  if (isPaletteKey(e) && !e.isComposing && !e.target.closest?.('#palette')) { e.preventDefault(); e.stopPropagation(); if (!isViewOnly()) palette.open(); return; }
  if (!(e.ctrlKey && e.shiftKey)) return;
  if (e.code === 'KeyG') { e.preventDefault(); toggleProgress(); }
  else if (e.code === 'KeyZ') { e.preventDefault(); toggleZen(); }
  else if (/^Digit[1-9]$/.test(e.code)) { const n = wsNames()[Number(e.code.slice(5)) - 1]; if (n) { e.preventDefault(); switchWs(n); } }
}, true);

// ---- leader key (tmux style prefix): Ctrl+Space, then one key. Mapping in leader.js; the hint sits in the bottom-left corner ----
const leaderHint = el('div', { id: 'leaderhint', role: 'status', hidden: true });
document.body.append(leaderHint);
let leaderChord = parseChord(store.get('leader', DEFAULT_LEADER)) || parseChord(DEFAULT_LEADER);
const leader = { armed: false, timer: null, dock: null, ws: false }; // dock: { id } while picking a window with Leader u
function leaderDisarm() {
  leader.armed = false; leader.dock = null; leader.ws = false; clearTimeout(leader.timer);
  if (numbering) { numbering = false; paintWorkspaces(); }
  leaderHint.hidden = true; wm.showNumbers(false); wm.selectWindow(null);
}
function leaderArm() {
  leader.armed = true; leader.dock = null; clearTimeout(leader.timer);
  const name = store.get('leader', DEFAULT_LEADER);
  leaderHint.textContent = `${name} ...  h j k l focus · 1-9 window · Tab next · t/Return terminal · q close · m minimize · d dock/release window · u dock · s show/hide dock · Shift+d show desktop · Shift+hjkl move · Ctrl+hjkl resize · o transparency · f maximize · a tile · p palette · ] [ workspace · w 1-9 workspace · Esc cancel`;
  leaderHint.hidden = false; wm.showNumbers(true);
}
function leaderDock() {
  const id = wm.startSelection();
  if (!id) { toast('No windows', 'info', 1500); return leaderDisarm(); }
  // No hint here: it would cover the windows being picked. Enter restores or focuses, anything else cancels.
  leader.dock = { id }; wm.showNumbers(false); wm.selectWindow(id); leaderHint.hidden = true;
}
function leaderDockKey(e) {
  const a = leaderAction(e);
  if (a?.action === 'ignore') return;
  if (isEnter(e)) { const { id } = leader.dock; leaderDisarm(); wm.activate(id); return; }
  if (a?.action === 'focus' && 'hjkl'.includes(a.dir)) { leader.dock.id = wm.moveSelection(leader.dock.id, a.dir); wm.selectWindow(leader.dock.id); return; }
  leaderDisarm(); // Esc or anything else
}
const toastPlace = (to) => (to ? toast(to === 'dock' ? 'Window docked' : 'Window released from the dock', 'info', 1200) : toast('No window is focused', 'info', 1500));
function leaderWsKey(e) { // after leader w: a digit jumps to that workspace
  const a = leaderAction(e);
  if (a?.action === 'ignore') return;
  const n = a?.action === 'number' ? wsNames()[a.n - 1] : null;
  leaderDisarm(); if (n) switchWs(n);
}
function leaderKey(e) {
  if (leader.dock) return leaderDockKey(e);
  if (leader.ws) return leaderWsKey(e);
  if (chordMatches(leaderChord, e)) return leaderArm(); // leader twice: stay in leader mode (the timer and hint restart)
  const a = leaderAction(e);
  if (a?.action === 'ignore') return;
  if (!a || a.action === 'cancel') return leaderDisarm();
  const ro = isViewOnly();
  switch (a.action) {
    case 'focus': wm.focusDirection(a.dir, $('term'), () => term.focus()); break;
    case 'number': wm.focusNumber(a.n); break;
    case 'next': wm.focusNext(); break;
    case 'terminal': wm.blur(); term.focus(); break;
    case 'close': if (!ro) wm.dismiss(); break; // no confirmation; the trash window can bring it back (unsaved editor or note changes still ask)
    case 'minimize': if (!ro) wm.dismiss(true); break;
    case 'desktop': if (!ro && wm.showDesktop() === 'none') toast('No windows to minimize', 'info', 1500); break;
    case 'dock': if (ro) break; return leaderDock();
    case 'toggledock': toggleDock(); break;
    case 'place': if (!ro) toastPlace(wm.togglePlacement()); break;
    case 'move': if (!ro) wm.moveFocused(a.dir); break;
    case 'resize': if (!ro) wm.resizeFocused(a.dir); break;
    case 'opacity': {
      const cur = ro ? null : wm.focusedTransparency();
      if (cur === null) break;
      const raw = window.prompt('Transparency of this window, 0-100 (0 = not transparent; above 80 is capped at 80)', String(cur));
      if (raw === null) break;
      const n = Number(raw.trim());
      if (raw.trim() === '' || !Number.isFinite(n) || n < 0 || n > 100) { toast('Enter a number from 0 to 100', 'warn'); break; }
      const t = wm.setTransparency(Math.round(n));
      toast(t ? `Window transparency ${t}%` : 'Window fully opaque', 'info', 1200);
      break;
    }
    case 'maximize': wm.toggleMaximize(); break;
    case 'tile': if (!ro) tileWindows().catch((x) => toast(x.message, 'bad')); break;
    case 'palette': if (!ro) palette.open(); break;
    case 'wsnext': case 'wsprev': { const names = wsNames(); const i = names.indexOf(wm.current()); const n = names[(i + (a.action === 'wsnext' ? 1 : names.length - 1)) % names.length]; if (n) switchWs(n); break; }
    case 'wsjump': leader.ws = true; numbering = true; paintWorkspaces(); leaderHint.textContent = 'workspace number 1-9 (Esc cancels)'; clearTimeout(leader.timer); leader.timer = setTimeout(leaderDisarm, 3000); return;
  }
  if (a.repeat) { // stay armed for a moment so h h h works; numbers are refreshed because focus moved
    clearTimeout(leader.timer); leader.timer = setTimeout(leaderDisarm, REPEAT_MS);
    wm.showNumbers(true);
  } else leaderDisarm();
}
addEventListener('keydown', (e) => {
  if (e.isComposing || e.target.closest?.('#palette')) return;
  if (leader.armed) { e.preventDefault(); e.stopPropagation(); leaderKey(e); return; }
  if (chordMatches(leaderChord, e)) { e.preventDefault(); e.stopPropagation(); leaderArm(); }
}, true);
addEventListener('blur', () => { if (leader.armed) leaderDisarm(); }); // switching tabs must not leave it armed

// ---- peek: hold Alt alone (key in Settings) to hide the floating windows; a CSS class on <html>, so layout and window state are never touched ----
let peekKey = peekKeyOrNull(store.get('peekKey', DEFAULT_PEEK));
const peek = createPeek({ getKey: () => peekKey, onChange: (on) => document.documentElement.classList.toggle('peek', on) });
// Capture phase and registered without stopPropagation: the leader and shortcut handlers and xterm see every key as before (a keydown also ends the peek).
addEventListener('keydown', (e) => peek.keydown(e), true);
addEventListener('keyup', (e) => { if (peek.keyup(e)) e.preventDefault(); }, true); // the release that ends a peek must not open the browser's menu bar
for (const ev of ['blur', 'pointerdown', 'contextmenu']) addEventListener(ev, () => peek.reset(), true);
document.addEventListener('visibilitychange', () => peek.reset());
document.addEventListener('focusout', (e) => { if (!e.relatedTarget) peek.reset(); }, true);
$('optPeek').value = peekKey || 'off';
$('optPeek').addEventListener('change', (e) => { peek.reset(); peekKey = peekKeyOrNull(e.target.value); store.set('peekKey', e.target.value); });

// ---- window arrangement (Emacs C-x 1 / tiling ideas) ----
async function tileWindows() {
  const list = wm.all().filter((p) => p.placement === 'float' && !p.minimized);
  if (!list.length) return toast('No floating windows to tile');
  const W = $('floats').clientWidth; const H = $('floats').clientHeight;
  const cols = Math.ceil(Math.sqrt(list.length)); const rows = Math.ceil(list.length / cols);
  const w = Math.floor(W / cols); const h = Math.floor(H / rows);
  await Promise.all(list.map((p, i) => ctx.patch(p.id, { x: (i % cols) * w + 4, y: Math.floor(i / cols) * h + 4, w: w - 8, h: h - 8 })));
}
const allPanels = (fn) => Promise.all(wm.all().map(fn));

// ---- extra keys bar for touch screens (Esc, Tab, sticky Ctrl, arrows, symbols that phone keyboards hide) ----
const KEYS = [['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl', null], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['Home', '\x1b[H'], ['End', '\x1b[F'], ['PgUp', '\x1b[5~'], ['PgDn', '\x1b[6~'], ['|', '|'], ['~', '~'], ['/', '/'], ['-', '-'], ['^C', '\x03'], ['^D', '\x04']];
const keysEl = $('keys'); let ctrlBtn = null;
keysEl.replaceChildren(...KEYS.map(([label, seq]) => {
  const b = el('button', { type: 'button', onpointerdown: (e) => e.preventDefault(), onclick: () => (seq === null ? term.toggleCtrl() : term.sendKey(seq)) }, label);
  if (seq === null) ctrlBtn = b; return b;
}));
term.onCtrl((on) => ctrlBtn.classList.toggle('on', on));
const touch = matchMedia('(pointer: coarse)').matches;
const setKeys = (on) => { keysEl.hidden = !on; $('optKeys').checked = on; term.fit(); };
$('optKeys').addEventListener('change', (e) => { store.set('keys', e.target.checked); setKeys(e.target.checked); });
setKeys(store.get('keys', touch));

// ---- recent files and clipboard history (Emacs recentf and kill-ring), kept per browser ----
// A path typed into a shell line: left alone when it is plain, single-quoted when it has spaces or shell characters.
const shq = (p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : /[\x00-\x1f\x7f]/.test(p) ? null : `'${p.replace(/'/g, `'\\''`)}'`);
const typePath = (p) => { const q = shq(p); if (q === null) return toast('That file name has control characters; its path was not typed', 'warn'); term.sendText(`${q} `); };
const remember = (key, item, max) => { const list = [item, ...store.get(key, []).filter((x) => x !== item)].slice(0, max); store.set(key, list); };
const openEditor = (p, line) => api('POST', '/api/panels', { type: 'editor', title: p.split('/').pop(), props: { path: p, ...(line && { line }) } }).catch((e) => toast(e.message, 'bad'));

// ---- welcome card: shown while nothing is open, until dismissed (per browser) ----
const welcome = $('welcome');
let welcomeBuilt = false; let gotSnapshot = false;
function paintWelcome() {
  const none = store.get('show-welcome', false) && gotSnapshot && !wm.all().length && !store.get('welcome-off', false);
  welcome.hidden = !none; if (!none || welcomeBuilt) return; // built once: a periodic rebuild would eat clicks
  welcomeBuilt = true;
  welcome.replaceChildren(el('h3', {}, 'Welcome to Hatch', el('button', { type: 'button', title: 'Do not show again', onclick: () => { store.set('welcome-off', true); paintWelcome(); } }, '×')),
    el('ul', {}, el('li', {}, el('kbd', {}, `${store.get('leader', DEFAULT_LEADER)}, p`), ' opens the command palette (the leader key, then p); Ctrl+P works too'), el('li', {}, 'Paste or drop an image anywhere to send it to the box'), el('li', {}, 'In the terminal run ', el('code', {}, 'hatch --help')), el('li', {}, el('kbd', {}, 'Ctrl+Shift+F'), ' finds in the scrollback; click ', el('code', {}, 'file:line'), ' in the output')),
    el('div', { class: 'row' }, el('button', { type: 'button', onclick: () => api('POST', '/api/desktop', {}) }, 'Open gadgets'), el('button', { type: 'button', onclick: () => api('POST', '/api/panels', { type: 'files', title: 'Files', props: { path: info.cwd } }) }, 'Browse files'), el('button', { type: 'button', onclick: () => palette.open() }, 'Commands')));
}
setInterval(paintWelcome, 1500);

// ---- report this page's own JavaScript errors to the server log ----
const reportError = (message, source, line) => { try { navigator.sendBeacon ? fetch('/api/clientlog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, source, line, agent: navigator.userAgent }) }).catch(() => {}) : null; } catch { /* reporting must never throw */ } };
addEventListener('error', (e) => reportError(e.message, e.filename, e.lineno));
addEventListener('unhandledrejection', (e) => reportError(`unhandled rejection: ${e.reason?.message || e.reason}`, '', 0));

// ---- command palette ----
let fileCache = null; // { dir, files } loaded each time the palette opens
// in-order character match, preferring matches inside the file name and shorter paths
function fuzzyScore(path, q) {
  const base = path.lastIndexOf('/') + 1;
  const run = (text, off) => { let i = 0; let last = -1; let gaps = 0; for (const ch of q) { const j = text.indexOf(ch, i); if (j < 0) return null; if (last >= 0) gaps += j - last - 1; last = j; i = j + 1; } return gaps; };
  const inName = run(path.slice(base), 0); // every character inside the file name beats a match spread over the directories
  if (inName !== null) return 1400 - inName * 2 - (path.slice(base).startsWith(q) ? 0 : 20) - path.length / 8;
  const whole = run(path, 0); if (whole === null) return -1;
  return 1000 - whole - (path.indexOf(q) >= base ? 0 : 40) - path.length / 4;
}
const runShell = (cmd) => api('POST', '/api/runs', { cmd, cwd: info.cwd }).then((r) => api('POST', '/api/panels', { type: 'output', title: cmd.slice(0, 40), props: { cmd, runId: r.id, cwd: info.cwd } }));
function primaryCommands() {
  return [
    { label: 'Focus terminal', hint: 'leader t / Return', run: () => { wm.blur(); term.focus(); } },
    { label: 'Open progress details', run: openProgress },
    { label: 'Toggle progress strip', hint: 'Ctrl+Shift+G', run: toggleProgress },
    { label: 'Open file browser', run: () => api('POST', '/api/panels', { type: 'files', title: 'Files', props: { path: info.cwd } }) },
    { label: 'New note', run: () => api('POST', '/api/panels', { type: 'note', title: 'Note', props: { markdown: '# Note\n\nDouble-click to edit.' } }) },
    { label: 'Keyboard shortcuts', run: showHelp },
  ];
}
const palette = createPalette({
  initialEntries: primaryCommands,
  onError: (e) => toast(e.message, 'bad'),
  usage: () => store.get('palette-usage', {}),
  onUsed: (label) => { const u = store.get('palette-usage', {}); u[label] = (u[label] || 0) + 1; const top = Object.entries(u).sort((a, b) => b[1] - a[1]).slice(0, 60); store.set('palette-usage', Object.fromEntries(top)); },
  // "!command" runs a shell command in an output window (Emacs M-!)
  dynamic: (q) => {
    // "=2*(3+4)": a calculator (Emacs calc); Enter copies the result and types nothing
    if (q.startsWith('=') && q.length > 1) {
      try { const r = formatResult(calc(q.slice(1))); return [{ label: `= ${r}`, hint: 'Enter copies the result', dynamic: true, run: async () => { const { copyText } = await import('./terminal.js'); toast((await copyText(r)) ? `Copied ${r}` : r, 'info', 3000); } }]; }
      catch (e) { return [{ label: `= ?`, hint: e.message, dynamic: true, run: () => {} }]; }
    }
    if (q.startsWith('!') && q.trim().length > 1) return [{ label: `Run in a window: ${q.slice(1).trim()}`, hint: 'shell command', dynamic: true, run: () => runShell(q.slice(1).trim()) }];
    // "/name" opens a file in an editor window (VS Code Ctrl+P); "@name" types an @path mention (Claude Code) into the terminal
    if ((q.startsWith('/') || q.startsWith('@')) && q.length > 1 && fileCache) {
      const want = q.slice(1).toLowerCase(); const at = q.startsWith('@');
      return fileCache.files.map((f) => [fuzzyScore(f.toLowerCase(), want), f]).filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0]).slice(0, 25)
        .map(([, f]) => ({ label: at ? `@${f}` : `Open: ${f}`, hint: at ? 'type into the terminal' : '', dynamic: true, run: () => (at ? (term.sendText(`@${f} `), term.focus()) : openEditor(`${fileCache.dir}/${f}`)) }));
    }
    return [];
  },
  entries: async () => {
    const out = primaryCommands();
    // all the lists the palette shows are requested at once (a LAN round trip each would add up when done one by one)
    const cache = new Map(); const get = (u) => { if (!cache.has(u)) cache.set(u, api('GET', u)); return cache.get(u); };
    for (const u of ['/api/files', '/api/tasks', '/api/ports', '/api/runs', '/api/bookmarks', '/api/examples', '/api/commands']) get(u).catch(() => {});
    get('/api/files').then((r) => { fileCache = r; palette.refresh(); }).catch(() => { fileCache = null; });
    const add = (label, hint, run) => out.push({ label, hint, run });
    add('Toggle dock', 'leader s', toggleDock);
    add('Reconnect terminal', '', () => term.connect());
    add('Larger terminal font', '', () => term.setFontSize(+1));
    add('Smaller terminal font', '', () => term.setFontSize(-1));
    add('Open desktop gadgets', 'graph, system, clock, top, git, log', () => api('POST', '/api/desktop', {}));
    add('Zen mode', 'Ctrl+Shift+Z', toggleZen);
    add('Windows: set default transparency...', 'for windows not set one by one; hatch set window-transparency', () => askTransparency('Default window transparency', 'A number 0-100 (0 = not transparent; above 80 is capped at 80), "default" (= 0), or "follow" (same as the terminal/page transparency).', (v) => api('PUT', '/api/transparency/windows', { percent: v === 'default' ? null : v }), true));
    add('Windows: set transparency of all open windows...', 'hatch windows transparency N', () => askTransparency('Transparency of all open windows', 'Percent 0-100 (0 = not transparent; above 80 is capped at 80). Applies to every window open now, each kept per window.', (v) => api('POST', '/api/panels/transparency', { percent: v }).then((r) => toast(`${r.changed} window${r.changed === 1 ? '' : 's'} set`, 'info', 1500))));
    for (const c of customCommands) add(c.label, c.hint, c.run);
    add('Show welcome tips', '', () => { store.set('show-welcome', true); store.set('welcome-off', false); paintWelcome(); });
    try { for (const t of await get('/api/tasks')) add(`Task: ${t.cmd}`, t.detail || t.source, () => api('POST', '/api/runs', { cmd: t.cmd, cwd: info.cwd }).then((r) => api('POST', '/api/panels', { type: 'output', title: t.cmd, props: { cmd: t.cmd, runId: r.id, cwd: info.cwd } }))); } catch { /* none */ }
    try { for (const x of await get('/api/ports')) add(`Open port ${x.port} in a window`, `${x.process || 'listening'} · ${x.scope}`, () => api('POST', '/api/panels', { type: 'iframe', title: `:${x.port}`, props: { url: `/proxy/${x.port}/` } })); } catch { /* none */ }
    try { for (const r of (await get('/api/runs')).slice(-12).reverse()) add(`Show run: ${r.cmd.slice(0, 50)}`, r.state === 'running' ? 'running' : `exit ${r.code}`, () => api('POST', '/api/panels', { type: 'output', title: r.cmd.slice(0, 40), props: { cmd: r.cmd, runId: r.id, cwd: r.cwd } })); } catch { /* none */ }
    add('Open session report', 'progress, runs, windows', () => api('GET', '/api/report').then((md) => api('POST', '/api/panels', { type: 'note', title: 'Session report', props: { markdown: md } })));
    add('Show server log', 'follows .hatch/log/server.log', () => { const f = `${info.stateDir}/log/server.log`; const cmd = `touch '${f}'; tail -n 200 -F '${f}'`; return api('POST', '/api/runs', { cmd, cwd: info.cwd }).then((r) => api('POST', '/api/panels', { type: 'output', title: 'server log', props: { cmd: `tail -F ${f}`, runId: r.id, cwd: info.cwd } })); });
    add('Show notification log', `${store.get('log', []).length} entries`, showLog);
    add('Find in terminal scrollback', 'Ctrl+Shift+F', () => openFind());
    try {
      const trash = await get('/api/trash');
      const reopen = (id) => api('POST', '/api/trash/restore', id ? { trashId: id } : {}).then((p) => toast(`Reopened ${p.title}${p.type === 'terminal' ? ' (a terminal restarts or reattaches; old scrollback is not restored)' : ''}`, 'info', 4000)).catch((e) => toast(e.message, 'bad'));
      if (trash.length) {
        add('Reopen closed window', trash[0].title, () => reopen());
        for (const e of trash) add(`Restore closed window: ${e.title}`, `${e.type} · closed ${e.closed ? new Date(e.closed).toLocaleString() : '?'}`, () => reopen(e.trashId));
        add('Empty trash of closed windows', `${trash.length} kept`, () => api('DELETE', '/api/trash').then((r) => toast(`Trash emptied (${r.removed})`, 'info', 2500)));
      }
    } catch { /* no trash */ }
    add('Tile floating windows', '', tileWindows);
    add('Minimize all windows', '', () => allPanels((p) => ctx.patch(p.id, { minimized: true })));
    add('Restore all windows', '', () => allPanels((p) => ctx.patch(p.id, { minimized: false })));
    add('Close all windows', '', () => allPanels((p) => wm.close(p.id)));
    add('New terminal window...', 'its own tmux session', () => { const n = (window.prompt('Name for the terminal (letters, digits, - and _)', 'shell2') || '').trim(); return n && api('POST', '/api/panels', { type: 'terminal', title: `term: ${n}`, props: { name: n } }); });
    try { for (const b of await get('/api/bookmarks')) add(`Bookmark: ${b.name}`, b.kind === 'missing' ? `${b.path} (missing)` : b.path, () => (b.kind === 'dir' ? api('POST', '/api/panels', { type: 'files', title: b.name, props: { path: b.path } }) : b.kind === 'file' ? openEditor(b.path) : toast(`${b.path} no longer exists`, 'warn'))); } catch { /* none */ }
    add('Bookmark a folder or file...', 'name = path', () => { const v = (window.prompt('Bookmark as  NAME = /absolute/path   (empty path = the server directory)') || '').trim(); if (!v) return; const [n, ...rest] = v.split('='); const pth = rest.join('=').trim() || info.cwd; return api('GET', '/api/bookmarks').then((l) => api('PUT', '/api/bookmarks', [...l.filter((b) => b.name !== n.trim()), { name: n.trim(), path: pth }])).then(() => toast(`Bookmarked ${n.trim()}`)).catch((e) => toast(e.message, 'bad')); });
    add('Open file by path...', 'find-file', () => { const p = (window.prompt('Absolute path, or one relative to the server directory (opens in an editor window)') || '').trim(); if (!p) return; return api('GET', `/api/fs/resolve?path=${encodeURIComponent(p)}`).then((r) => openEditor(r.path)).catch((e) => toast(e.message, 'warn', 7000)); });
    for (const f of store.get('recent', [])) add(`Recent file: ${f.split('/').slice(-2).join('/')}`, f, () => openEditor(f));
    for (const c of store.get('clips', []).slice(0, 10)) add(`Paste from history: ${c.replace(/\s+/g, ' ').slice(0, 50)}`, `${c.length} chars`, () => { term.sendText(c); term.focus(); });
    add('workspace: switch', `${wsNames().length} workspaces · leader ] [ or w 1-9`, () => pickWorkspace((n) => switchWs(n), { exclude: [wm.current()] }));
    add('workspace: new', 'its own terminal, windows and background', newWorkspace);
    add('workspace: rename', wm.current(), renameWorkspace);
    add('workspace: close', 'asks you to type the name', () => closeWorkspace());
    add('workspace: set background...', `for ${wm.current()} only`, setWorkspaceBackground);
    add('window: move to workspace...', 'the terminal keeps running', moveWindowToWorkspace);
    add('Move all windows to the current workspace', '', () => allPanels((p) => ctx.patch(p.id, { ws: wm.current() })));
    add('Close focused popup', 'leader q', () => wm.dismiss());
    add('Minimize focused popup', 'leader m', () => wm.dismiss(true));
    add('Show desktop: minimize all windows, again to restore', 'leader Shift+d', () => { if (wm.showDesktop() === 'none') toast('No windows to minimize', 'info', 1500); });
    try {
      const f = await get(`/api/fx?ws=${encodeURIComponent(wm.current())}`); const setFx = (body) => api('POST', '/api/fx', { ...body, ws: wm.current() }).catch((e) => toast(e.message, 'bad'));
      for (const n of [...f.effects, 'off']) add(n === 'off' ? 'Background effect: off' : `Background effect: ${n}`, `hatch fx ${n}`, () => setFx({ effect: n }));
      if (f.effect) for (const [label, d] of [['stronger', 20], ['weaker', -20]]) add(`Background effect: ${label}`, `intensity ${f.intensity}`, () => setFx({ intensity: Math.max(0, Math.min(100, f.intensity + d)) }));
    } catch { /* no effects list */ }
    add('Dock or release the focused window', 'leader d', () => toastPlace(wm.togglePlacement()));
    add('Restore last minimized popup', 'leader u', () => { if (!wm.restoreNext()) toast('No minimized popups', 'info', 1500); });
    add('Open URL in a window...', '', () => { const u = prompt2('URL to open (the browser must reach it)'); return u && api('POST', '/api/panels', { type: 'iframe', title: u, props: { url: u } }); });
    add('Open all example widgets', 'every default popup at its default size', async () => { for (const x of await get('/api/examples')) await api('POST', `/api/examples/${x.name}/open`, {}); });
    try { for (const x of await get('/api/examples')) add(`Example widget: ${x.title}`, x.stale ? `${x.name} (newer version shipped: hatch-server update-widgets ${x.name})` : x.name, () => api('POST', `/api/examples/${x.name}/open`, {}).then((r) => { if (x.stale) toast(x.hint, 'warn'); return r; })); } catch { /* none */ }
    for (const w of widgets.values()) add(`Open widget: ${w.name}`, w.meta?.title || '', () => api('POST', '/api/panels', { type: 'widget', props: { name: w.name } }));
    for (const p of wm.all()) {
      add(`Switch to popup: ${p.title}`, `${p.type}${p.minimized ? ' · minimized' : ''} · ${p.ws || 'main'}`, () => {
        if (!p.sticky) switchWs(p.ws || 'main');
        if (p.minimized) return wm.restore(p.id);
        wm.focusPanel(p.id);
      });
      add(`Close window: ${p.title}`, p.id, () => wm.close(p.id));
      add(`Rename window: ${p.title}`, p.id, () => { const n = (window.prompt('New title', p.title) || '').trim(); return n && ctx.patch(p.id, { title: n.slice(0, 80) }); });
      add(`${p.sticky ? 'Unpin from all workspaces' : 'Pin to all workspaces'}: ${p.title}`, p.id, () => ctx.patch(p.id, { sticky: !p.sticky }));
      if (p.placement === 'float') {
        const W = () => $('floats').clientWidth; const H = () => $('floats').clientHeight;
        add(`Snap window left: ${p.title}`, p.id, () => ctx.patch(p.id, { x: 0, y: 0, w: Math.floor(W() / 2), h: H(), minimized: false }));
        add(`Snap window right: ${p.title}`, p.id, () => ctx.patch(p.id, { x: Math.floor(W() / 2), y: 0, w: Math.floor(W() / 2), h: H(), minimized: false }));
        add(`Fill the terminal area: ${p.title}`, p.id, () => ctx.patch(p.id, { x: 0, y: 0, w: W(), h: H(), minimized: false }));
      }
      add(`${p.minimized ? 'Restore' : 'Minimize'} window: ${p.title}`, p.id, () => ctx.patch(p.id, { minimized: !p.minimized }));
    }
    add('Search in files...', 'grep', () => { const q = (window.prompt('Search for (regex), in the server directory') || '').trim(); if (!q) return; const sq = (x) => `'${x.replace(/'/g, `'\\''`)}'`; const cmd = `if command -v rg >/dev/null 2>&1; then rg -n --no-heading --color never -- ${sq(q)} .; else grep -rnI --exclude-dir=.git --exclude-dir=node_modules -- ${sq(q)} .; fi`; return api('POST', '/api/runs', { cmd, cwd: info.cwd }).then((r) => api('POST', '/api/panels', { type: 'output', title: `grep ${q}`.slice(0, 40), props: { cmd: `grep ${q}`, runId: r.id, cwd: info.cwd, rerun: cmd } })); });
    add('Refresh Claude limits', '5-hour and weekly usage', () => limitsUi.refresh());
    add('Open git window', 'status, stage, commit', () => api('POST', '/api/panels', { type: 'git', title: 'Git', props: { dir: info.cwd } }));
    add('Open trash window', 'list and restore closed windows', () => api('POST', '/api/panels', { type: 'trash', title: 'Trash' }));
    add('Git diff', '', () => api('POST', '/api/runs', { cmd: 'git --no-pager diff --no-color', cwd: info.cwd }).then((r) => api('POST', '/api/panels', { type: 'output', title: 'git diff', props: { cmd: 'git diff', runId: r.id, cwd: info.cwd, kind: 'diff', rerun: 'git --no-pager diff --no-color' } })));
    add('Run a command in an output window...', 'compilation-mode', () => { const c = (window.prompt('Command to run (output appears in its own window)') || '').trim(); return c && api('POST', '/api/runs', { cmd: c, cwd: info.cwd }).then((r) => api('POST', '/api/panels', { type: 'output', title: c.slice(0, 40), props: { cmd: c, runId: r.id, cwd: info.cwd } })); });
    try { for (const c of (await get('/api/commands')).filter((x) => !x.paste)) add(`Run in window: ${c.name}`, c.text, () => api('POST', '/api/runs', { cmd: c.text, cwd: info.cwd }).then((r) => api('POST', '/api/panels', { type: 'output', title: c.name, props: { cmd: c.text, runId: r.id, cwd: info.cwd } }))); } catch { /* none */ }
    try { for (const c of await get('/api/commands')) add(c.paste ? `Prompt: ${c.name}` : `Run: ${c.name}`, c.text.split('\n')[0].slice(0, 60), () => { if (c.paste) term.sendText(c.text); else term.type(c.text + (c.enter ? '\r' : '')); term.focus(); }); } catch { /* none saved */ }
    const primary = ['Focus terminal', 'Open progress details', 'Toggle progress strip', 'Open file browser', 'New note', 'Keyboard shortcuts'];
    return out.sort((a, b) => (primary.includes(a.label) ? primary.indexOf(a.label) : 100) - (primary.includes(b.label) ? primary.indexOf(b.label) : 100));
  },
});
// a prompt replacement: the real prompt() is unavailable in some embedded viewers and blocks the page
function prompt2(msg) { return window.prompt(msg) || ''; }
$('palbtn').addEventListener('click', () => palette.open());

wm.setWorkspace('main'); paintWorkspaces(); // the right workspace is chosen after the first snapshot (URL hash, else last used)
connectEvents();
// ---- customisation API for .hatch/custom.js (loaded below; it is a plain ES module you own) ----
const customCommands = []; const customHandlers = {};
window.hatchUI = {
  /** Adds a palette entry: addCommand('Deploy', () => ..., 'optional hint'). */
  addCommand: (label, run, hint = 'custom') => customCommands.push({ label, hint, run }),
  /** on('notify' | 'panel' | 'progress' | 'ask' | 'copy', fn): called with each event's data. */
  on: (event, fn) => { (customHandlers[event] ||= []).push(fn); },
  api, toast, notify, wm, term, ctx, store, version: 1,
};
window.hatchUI.emit = (event, data) => { for (const f of customHandlers[event] || []) { try { f(data); } catch (e) { console.error(`custom.js handler for ${event} failed`, e); } } };
// custom.css / custom.js are requested only when the server says they exist (no 404 noise in the console)
let customLoaded = false;
function loadCustom(c) {
  if (customLoaded || !c) return; customLoaded = true;
  if (c.css) document.head.append(el('link', { rel: 'stylesheet', href: '/custom/custom.css', onload: () => term.retheme?.() })); // the terminal read its colours at start-up, before this file existed
  if (c.js) import('/custom/custom.js').then(() => console.info('custom.js loaded')).catch((e) => toast(`custom.js: ${e.message}`, 'warn', 8000));
}

// expose for tests / debugging
window.hatchApp = { wm, term, api, widgets, wsNames, switchWs };

// Claude plan limits in the header (hidden without the Claude CLI)
const limitsUi = initLimits({ el, api, toast, node: $('limits') });
if (!isViewOnly()) limitsUi.start();
