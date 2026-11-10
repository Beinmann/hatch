import { isViewOnly } from './util.js';
import { pickRestore } from './restore.js';
import { touch, pickAfterClose } from './focus-history.js';
import { planShowDesktop, rememberMinimized } from './show-desktop.js';
import { step, listStep } from './direction.js';
// Window manager, plain DOM. A panel is either `float` (draggable and resizable over the terminal) or `dock`
// (stacked in the right column). Geometry changes are written back to the panel file (debounced), so the layout
// survives reloads. New and restored popups take focus; the terminal has an explicit focus shortcut.
const SAVE_MS = 300;
const MIN_W = 180; const MIN_H = 90;

export function createWindows({ floats, dock, split, chips, el, patch, close, kinds, ctx, onDockChange, dockOpen = () => true, openDock = () => {} }) {
  const wins = new Map(); // id -> { panel, node, body, view, tb }
  let current = 'main'; // the workspace being shown
  const wsOf = (p) => p.ws || 'main';
  const shown = (w) => !w.panel.minimized && (w.panel.sticky || wsOf(w.panel) === current);
  let z = 10; // unbounded is fine: #floats isolates its stacking context, so this can never reach #palette
  let focusHistory = []; // window ids, most recently focused first (per page load)
  const minOrder = new Map(); let minSeq = 0; // id -> when it was minimized, for restoreNext
  const timers = new Map();
  const visibilitySaves = new Map(); const visibilityPending = new Map();

  // Debounced per window; fields of calls inside the delay are merged (a keyboard move then resize must save both).
  const pendingFields = new Map();
  const save = (id, fields) => {
    clearTimeout(timers.get(id));
    pendingFields.set(id, { ...pendingFields.get(id), ...fields });
    timers.set(id, setTimeout(() => { const f = pendingFields.get(id); pendingFields.delete(id); patch(id, f).catch(() => {}); }, SAVE_MS));
  };

  function focus(w, keyboard = true) {
    if (!shown(w)) return;
    for (const o of wins.values()) o.node.classList.toggle('focus', o === w);
    focusHistory = touch(focusHistory, w.panel.id);
    if (w.panel.placement === 'float') w.node.style.zIndex = String(++z);
    if (keyboard) { w.node.focus({ preventScroll: true }); w.view.focus?.(); }
    if (typeof paintChips === 'function') paintChips();
  }

  function layoutFloat(w) {
    const p = w.panel; const n = w.node;
    const maxW = floats.clientWidth || 800; const maxH = floats.clientHeight || 600;
    const width = Math.max(MIN_W, Math.min(p.w || 420, maxW)); const height = Math.max(MIN_H, Math.min(p.h || 300, maxH));
    n.style.width = `${width}px`; n.style.height = `${height}px`;
    n.style.left = `${Math.max(0, Math.min(p.x ?? 40, maxW - 60))}px`; n.style.top = `${Math.max(0, Math.min(p.y ?? 40, maxH - 40))}px`;
  }
  function layoutDock(w) { w.node.style.cssText = `height:${Math.max(MIN_H, w.panel.h || 260)}px`; }

  function mount(w) {
    const p = w.panel;
    w.node.className = `win ${p.placement === 'dock' ? 'docked' : 'float'}${p.maximized ? ' max' : ''}`;
    (p.placement === 'dock' ? dock : floats).append(w.node);
    if (p.placement === 'dock') layoutDock(w); else layoutFloat(w);
    w.node.hidden = !shown(w); applyOpacity(w);
  }

  // Same table as src/convert.js; the server checks it again and answers with the possible types when it does not apply.
  const CONVERT = { note: ['progress', 'widget'], progress: ['note'], widget: ['note'] };
  async function convert(panel) {
    if (isViewOnly()) return;
    const targets = CONVERT[panel.type];
    if (!targets) return ctx.toast(`a ${panel.type} window cannot be converted (only ${Object.keys(CONVERT).join(', ')})`, 'bad');
    const to = targets.length === 1 ? targets[0] : (prompt(`Convert "${panel.title}" to: ${targets.join(' or ')}`, targets[0]) || '').trim();
    if (!to) return;
    try { await ctx.api('POST', `/api/panels/${encodeURIComponent(panel.id)}/convert`, { to }); } catch (e) { ctx.toast(e.message, 'bad'); }
  }

  function build(panel) {
    const kind = kinds[panel.type];
    const w = { panel, node: el('div', { class: 'win', tabindex: '-1', role: 'region', 'aria-label': panel.title, 'data-id': panel.id }), view: null };
    const title = el('span', { class: 't' }, panel.title);
    w.title = title;
    const mkBtn = (label, tip, fn) => el('button', { type: 'button', title: tip, 'aria-label': tip, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
    w.tb = el('div', { class: 'tb' }, title,
      mkBtn(panel.placement === 'dock' ? '⇱' : '⇲', 'Move between dock and floating', () => {
        const to = w.panel.placement === 'dock' ? 'float' : 'dock';
        patch(w.panel.id, { placement: to }).catch(() => {});
      }),
      mkBtn('⇄', 'Convert to another type (note, widget, progress)', () => convert(w.panel)),
      mkBtn('–', 'Minimize', () => setMinimized(w.panel.id, true).catch((e) => ctx.toast(e.message, 'bad'))),
      mkBtn('×', 'Close', () => requestClose(w.panel.id).catch((e) => ctx.toast(e.message, 'bad'))));
    w.body = el('div', { class: 'body' });
    w.rz = el('div', { class: 'rz', title: 'Resize' });
    w.node.append(w.tb, w.body, w.rz);
    w.view = kind.create(panel, ctx);
    w.body.append(w.view.el);
    // double-click the title bar: maximize over the terminal and back (in the page only, geometry is not saved)
    w.tb.addEventListener('dblclick', (e) => { if (!isViewOnly() && !e.target.closest('button') && w.panel.placement === 'float') patch(w.panel.id, { maximized: !w.panel.maximized }).catch((e) => ctx.toast(e.message, 'bad')); });
    drag(w); resize(w);
    // remember whether the window was already focused, so a panel can tell a focusing click from a later one (image zoom)
    w.node.addEventListener('pointerdown', () => { w.node.dataset.hadFocus = w.node.classList.contains('focus') ? '1' : ''; focus(w, false); }, true);
    w.node.addEventListener('focusin', () => focus(w, false));
    wins.set(panel.id, w);
    mount(w);
    if (panel.autoFocus !== false) focus(w);
    return w;
  }

  function drag(w) {
    w.tb.addEventListener('pointerdown', (e) => {
      if (isViewOnly() || w.panel.placement !== 'float' || e.target.closest('button')) return;
      e.preventDefault();
      w.tb.setPointerCapture(e.pointerId);
      const sx = e.clientX; const sy = e.clientY; const ox = w.node.offsetLeft; const oy = w.node.offsetTop;
      w.node.classList.add('dragging');
      const move = (m) => {
        const x = Math.max(0, Math.min(ox + m.clientX - sx, floats.clientWidth - 60)); const y = Math.max(0, Math.min(oy + m.clientY - sy, floats.clientHeight - 30));
        w.node.style.left = `${x}px`; w.node.style.top = `${y}px`;
      };
      const up = () => {
        w.tb.removeEventListener('pointermove', move); w.tb.removeEventListener('pointerup', up); w.tb.removeEventListener('pointercancel', up);
        w.node.classList.remove('dragging');
        w.panel = { ...w.panel, x: w.node.offsetLeft, y: w.node.offsetTop };
        save(w.panel.id, { x: w.panel.x, y: w.panel.y });
      };
      w.tb.addEventListener('pointermove', move); w.tb.addEventListener('pointerup', up); w.tb.addEventListener('pointercancel', up);
    });
  }

  function resize(w) {
    w.rz.addEventListener('pointerdown', (e) => {
      if (isViewOnly()) return;
      e.preventDefault(); e.stopPropagation();
      w.rz.setPointerCapture(e.pointerId);
      const sx = e.clientX; const sy = e.clientY; const ow = w.node.offsetWidth; const oh = w.node.offsetHeight;
      const docked = w.panel.placement === 'dock';
      w.node.classList.add('resizing');
      const move = (m) => {
        if (!docked) w.node.style.width = `${Math.max(MIN_W, ow + m.clientX - sx)}px`;
        w.node.style.height = `${Math.max(MIN_H, oh + m.clientY - sy)}px`;
      };
      const up = () => {
        w.rz.removeEventListener('pointermove', move); w.rz.removeEventListener('pointerup', up); w.rz.removeEventListener('pointercancel', up);
        w.node.classList.remove('resizing');
        const f = { h: w.node.offsetHeight, ...(!docked && { w: w.node.offsetWidth }) };
        w.panel = { ...w.panel, ...f };
        save(w.panel.id, { ...f, remember: true });
      };
      w.rz.addEventListener('pointermove', move); w.rz.addEventListener('pointerup', up); w.rz.addEventListener('pointercancel', up);
    });
  }

  // On screen right now: shown, and (when docked) the dock column is open. Minimized, folded-dock and other-workspace
  // windows are not; other-workspace windows get no chip at all.
  const onScreen = (w) => shown(w) && (w.panel.placement !== 'dock' || dockOpen());
  function chipFor(w) {
    const hidden = !onScreen(w);
    return el('button', { type: 'button', class: `chip${w.panel.minimized ? ' min' : ''}${hidden ? ' off' : ''}${w.node.classList.contains('focus') ? ' ok' : ''}${w.panel.id === dockSel ? ' sel' : ''}`, 'data-id': w.panel.id, title: w.panel.minimized ? 'Restore' : hidden ? 'Open the dock and show' : 'Bring to front', disabled: isViewOnly() && w.panel.minimized,
      onclick: () => {
        if (w.panel.minimized) { setMinimized(w.panel.id, false).catch((e) => ctx.toast(e.message, 'bad')); return; }
        if (w.panel.placement === 'dock' && !dockOpen()) { openDock(); paintDock(); } // the dock must be on screen before focusing into it
        focus(w); w.node.classList.add('flash'); setTimeout(() => w.node.classList.remove('flash'), 600);
      } }, w.panel.title);
  }
  function paintChips() {
    // Taskbar: windows of this workspace, visible ones first, a separator, then the ones not on screen.
    const mine = [...wins.values()].filter((w) => w.panel.sticky || wsOf(w.panel) === current);
    chips.parentElement.hidden = !mine.length;
    const vis = mine.filter(onScreen); const off = mine.filter((w) => !onScreen(w));
    chips.replaceChildren(...vis.map(chipFor), ...(vis.length && off.length ? [el('span', { class: 'chipsep', role: 'separator', 'aria-hidden': 'true' })] : []), ...off.map(chipFor));
  }
  function paintDock() {
    const any = [...wins.values()].some((w) => w.panel.placement === 'dock' && shown(w));
    onDockChange(any);
  }

  function upsert(panel) {
    const pending = visibilityPending.get(panel.id);
    if (pending) panel = { ...panel, ...pending.fields };
    const w = wins.get(panel.id);
    if (panel.minimized && !(w && w.panel.minimized)) minOrder.set(panel.id, ++minSeq);
    if (!w) { build(panel); paintChips(); paintDock(); return; }
    const old = w.panel; const heldFocus = w.node.contains(document.activeElement); w.panel = panel;
    if (old.title !== panel.title) w.title.textContent = panel.title;
    if (old.placement !== panel.placement) {
      // Preserve the view: rebuilding discards unsaved editor buffers and other local popup state.
      w.tb.querySelector('button').textContent = panel.placement === 'dock' ? '⇱' : '⇲';
      mount(w); if (panel.autoFocus !== false) focus(w);
    } else {
      if (panel.placement === 'float' && !w.node.classList.contains('dragging') && !w.node.classList.contains('resizing')) {
        if (['x', 'y', 'w', 'h'].some((k) => old[k] !== panel[k])) layoutFloat(w);
      } else if (panel.placement === 'dock' && old.h !== panel.h && !w.node.classList.contains('resizing')) layoutDock(w);
      w.node.hidden = !shown(w);
      if (panel.minimized && heldFocus) ctx.term?.focus();
      if (JSON.stringify(old.props) !== JSON.stringify(panel.props)) w.view.update(panel);
    }
    w.node.classList.toggle('max', !!panel.maximized); applyOpacity(w);
    if (panel.autoFocus !== false && ((old.minimized && !panel.minimized) || old.activation !== panel.activation)) focus(w);
    if (panel.placement === 'dock' && !panel.minimized && panel.autoFocus !== false && (old.placement !== 'dock' || old.activation !== panel.activation || old.minimized)) openDock();
    paintChips(); paintDock();
  }

  async function setMinimized(id, minimized) {
    if (isViewOnly()) return;
    const w = wins.get(id); if (!w) return;
    const before = w.panel;
    const fields = { minimized, ...(!minimized && { autoFocus: true }) };
    const intent = { fields };
    visibilityPending.set(id, intent);
    // Restore locally before saving; serialize writes so rapid toggles persist the last intention.
    upsert({ ...before, ...fields });
    if (!minimized) focus(w);
    const saving = (visibilitySaves.get(id) || Promise.resolve()).catch(() => {}).then(() => patch(id, fields));
    visibilitySaves.set(id, saving);
    try { await saving; }
    catch (e) {
      if (visibilityPending.get(id) === intent && wins.get(id) === w) {
        visibilityPending.delete(id); upsert(before);
      }
      throw e;
    } finally {
      if (visibilityPending.get(id) === intent) visibilityPending.delete(id);
      if (visibilitySaves.get(id) === saving) visibilitySaves.delete(id);
    }
  }

  async function requestClose(id) {
    if (isViewOnly()) return false;
    const w = wins.get(id);
    if (!w) return false;
    if (w.view.beforeClose && !await w.view.beforeClose()) { w.view.focus?.(); return false; }
    await close(id); return true;
  }

  function remove(id) {
    const w = wins.get(id);
    if (!w) return;
    const hadFocus = w.node.contains(document.activeElement) || w.node.classList.contains('focus');
    w.view.destroy(); w.node.remove(); wins.delete(id); visibilityPending.delete(id);
    focusHistory = focusHistory.filter((h) => h !== id);
    if (hadFocus) {
      // Back to what was focused before; the terminal only when no other window is open and visible.
      const prev = wins.get(pickAfterClose(focusHistory, id, (h) => { const o = wins.get(h); return o && shown(o); }));
      if (prev) focus(prev); else ctx.term?.focus();
    }
    paintChips(); paintDock();
  }

  // Dock splitter: drag to resize, width is remembered per browser.
  split.addEventListener('pointerdown', (e) => {
    e.preventDefault(); split.setPointerCapture(e.pointerId);
    const move = (m) => { dock.style.width = `${Math.max(200, Math.min(window.innerWidth * 0.7, window.innerWidth - m.clientX))}px`; };
    const up = () => {
      split.removeEventListener('pointermove', move); split.removeEventListener('pointerup', up);
      try { localStorage.setItem('hatch.dockw', dock.style.width); } catch { /* storage may be blocked */ }
    };
    split.addEventListener('pointermove', move); split.addEventListener('pointerup', up);
  });
  try { const sw = localStorage.getItem('hatch.dockw'); if (sw) dock.style.width = sw; } catch { /* ignore */ }

  function setWorkspace(name) { current = name || 'main'; for (const w of wins.values()) w.node.hidden = !shown(w); paintChips(); paintDock(); }
  // Leader h/j/k/l: move focus to the nearest visible window (or the terminal) in that direction.
  // Selection lives in direction.js (deterministic, and the opposite key retraces the path).
  let trail = [];
  const TERM = '\u0000term';
  function focusDirection(dir, termEl, focusTerm) {
    const src = [...wins.values()].find((w) => shown(w) && w.node.classList.contains('focus'));
    const rect = (id, n) => { const r = n.getBoundingClientRect(); return { id, x: r.left + r.width / 2, y: r.top + r.height / 2, empty: !r.width || !r.height }; };
    const items = [...wins.values()].filter((w) => shown(w)).map((w) => rect(w.panel.id, w.node)); items.push(rect(TERM, termEl));
    const r = step(trail, items, src ? src.panel.id : TERM, dir);
    trail = r.trail;
    if (r.id === null) return false;
    if (r.id === TERM) { blur(); focusTerm(); } else focus(wins.get(r.id));
    return true;
  }
  function blur() { for (const w of wins.values()) w.node.classList.remove('focus'); paintChips(); }
  const focused = () => [...wins.values()].find((o) => shown(o) && o.node.classList.contains('focus'));
  // Windows that can be reached by number: visible and not minimized, in creation order (the same order the badges show).
  const numbered = () => [...wins.values()].filter((w) => shown(w));
  function showNumbers(on) { numbered().forEach((w, i) => { if (on) w.tb.dataset.n = String(i + 1); else delete w.tb.dataset.n; }); if (!on) for (const w of wins.values()) delete w.tb.dataset.n; }
  function focusNumber(n) { const w = numbered()[n - 1]; if (!w) return false; focus(w); return true; }
  // Leader Tab: raise the next visible window, docked ones included.
  function focusNext() { const list = numbered(); if (!list.length) return false; const i = list.findIndex((w) => w.node.classList.contains('focus')); focus(list[(i + 1) % list.length]); return true; }
  // Leader f: maximize or restore the focused floating window (page only, like the title-bar double-click).
  function toggleMaximize() {
    const w = focused();
    if (!w || isViewOnly() || w.panel.placement !== 'float') return false;
    patch(w.panel.id, { maximized: !w.panel.maximized }).catch((e) => ctx.toast(e.message, 'bad')); return true;
  }
  // Leader u: every window of this workspace, in taskbar order (on screen first, then minimized or folded); one is marked as the selection.
  let dockSel = null;
  const selectableIds = () => {
    const mine = [...wins.values()].filter((w) => w.panel.sticky || wsOf(w.panel) === current);
    return [...mine.filter(onScreen), ...mine.filter((w) => !onScreen(w))].map((w) => w.panel.id);
  };
  // Minimized windows come first when picking, so the old "restore one" use stays one keypress away.
  const startSelection = () => {
    const ids = selectableIds(); const min = ids.find((id) => wins.get(id).panel.minimized);
    const foc = ids.find((id) => wins.get(id).node.classList.contains('focus'));
    return min || foc || ids[0] || null;
  };
  function selectWindow(id) {
    dockSel = id;
    for (const w of wins.values()) w.node.classList.toggle('pick', w.panel.id === id);
    paintChips();
  }
  // Next selection from `id` for h/j/k/l: between windows on screen by geometry (nearest centre in that direction),
  // otherwise h/l step through the list (which is how minimized chips are reached) and j/k stay put.
  function moveSelection(id, dir) {
    const ids = selectableIds(); if (!ids.length) return null;
    const i = Math.max(0, ids.indexOf(id)); const cur = wins.get(ids[i]);
    if (cur && onScreen(cur)) {
      const c = cur.node.getBoundingClientRect(); const cx = c.left + c.width / 2; const cy = c.top + c.height / 2;
      let best = null; let bestScore = Infinity;
      for (const o of ids.map((x) => wins.get(x))) {
        if (o === cur || !onScreen(o)) continue;
        const r = o.node.getBoundingClientRect(); const dx = r.left + r.width / 2 - cx; const dy = r.top + r.height / 2 - cy;
        const [along, across] = dir === 'h' ? [-dx, dy] : dir === 'l' ? [dx, dy] : dir === 'k' ? [-dy, dx] : [dy, dx];
        if (along <= 0) continue;
        const score = along + 2 * Math.abs(across);
        if (score < bestScore) { bestScore = score; best = o.panel.id; }
      }
      if (best) return best;
    }
    if (dir === 'h' || dir === 'l') return listStep(ids, ids.filter((x) => !onScreen(wins.get(x))), ids[i], dir);
    return ids[i];
  }
  // Enter in the picker: restore a minimized window, otherwise bring the window to front like its chip does.
  function activate(id) {
    const w = wins.get(id); if (!w) return;
    if (w.panel.minimized) { if (!isViewOnly()) setMinimized(id, false).catch((e) => ctx.toast(e.message, 'bad')); return; }
    if (w.panel.placement === 'dock' && !dockOpen()) { openDock(); paintDock(); }
    focus(w); w.node.classList.add('flash'); setTimeout(() => w.node.classList.remove('flash'), 600);
  }
  // Leader Shift+h/j/k/l: nudge the focused floating window by a fixed step, clamped like a drag, and persist like one.
  // Docked, minimized, maximized or hidden windows are left alone.
  function moveFocused(dir, step = 40) {
    const w = [...wins.values()].find((o) => shown(o) && o.node.classList.contains('focus'));
    if (!w || isViewOnly() || w.panel.placement !== 'float' || w.panel.minimized || w.panel.maximized) return false;
    const [dx, dy] = { h: [-1, 0], l: [1, 0], k: [0, -1], j: [0, 1] }[dir];
    const x = Math.max(0, Math.min(w.node.offsetLeft + dx * step, floats.clientWidth - 60)); const y = Math.max(0, Math.min(w.node.offsetTop + dy * step, floats.clientHeight - 30));
    w.node.style.left = `${x}px`; w.node.style.top = `${y}px`;
    w.panel = { ...w.panel, x, y }; save(w.panel.id, { x, y });
    return true;
  }
  // Leader Ctrl+h/j/k/l: grow or shrink the focused floating window (h/k shrink, l/j grow), clamped to the viewport, saved like a drag.
  function resizeFocused(dir, step = 40) {
    const w = focused();
    if (!w || isViewOnly() || w.panel.placement !== 'float' || w.panel.minimized || w.panel.maximized) return false;
    const [dw, dh] = { h: [-1, 0], l: [1, 0], k: [0, -1], j: [0, 1] }[dir];
    const maxW = floats.clientWidth || 800; const maxH = floats.clientHeight || 600;
    const width = Math.max(MIN_W, Math.min(w.node.offsetWidth + dw * step, maxW - w.node.offsetLeft));
    const height = Math.max(MIN_H, Math.min(w.node.offsetHeight + dh * step, maxH - w.node.offsetTop));
    w.node.style.width = `${width}px`; w.node.style.height = `${height}px`;
    w.panel = { ...w.panel, w: width, h: height }; save(w.panel.id, { w: width, h: height, remember: true });
    return true;
  }
  // Leader o: the focused window's transparency, asked as a number 0-100 (0 = not transparent, the default). Stored as
  // `opacity` (100 - transparency, floored at 20 so a window cannot vanish); 0 stores 100 = fully opaque, ignoring the
  // global transparency (--opa pinned to 100% on the window); only a window never set follows the global setting.
  // Values below 100 are applied as CSS opacity on top of that.
  const OPA_MIN = 20;
  const applyOpacity = (w) => { const o = w.panel.opacity; w.node.style.opacity = o && o < 100 ? String(o / 100) : ''; if (o) w.node.style.setProperty('--opa', '100%'); else w.node.style.removeProperty('--opa'); };
  const focusedTransparency = () => { const w = focused(); return w ? 100 - (w.panel.opacity ?? 100) : null; };
  function setTransparency(t) {
    const w = focused();
    if (!w || isViewOnly()) return null;
    const next = Math.max(OPA_MIN, Math.min(100, 100 - t));
    w.panel = { ...w.panel, opacity: next }; applyOpacity(w); save(w.panel.id, { opacity: next });
    return 100 - next;
  }
  const workspaces = () => ['main', ...[...new Set([current, ...[...wins.values()].map((w) => wsOf(w.panel))])].filter((n) => n !== 'main').sort()]; // stable: main first, the rest alphabetical

  // Show desktop (leader d): minimize every floating window; again before anything changed: bring them back (see show-desktop.js).
  let desktopMemo = null;
  function showDesktop() {
    if (isViewOnly()) return 'none';
    const panels = [...wins.values()].map((w) => w.panel);
    const plan = planShowDesktop(panels, current, desktopMemo, focusHistory);
    desktopMemo = null;
    if (plan.action === 'none') return 'none';
    const done = (e) => ctx.toast(e.message, 'bad');
    if (plan.action === 'restore') { for (const id of plan.ids) setMinimized(id, false).catch(done); return 'restored'; }
    for (const id of plan.ids) setMinimized(id, true).catch(done); // each call updates the local state before it awaits
    desktopMemo = rememberMinimized([...wins.values()].map((w) => w.panel), current, plan.ids);
    return 'minimized';
  }

  return {
    showDesktop,
    focusPanel(id, keyboard = true) { const w = wins.get(id); if (w) focus(w, keyboard); },
    blur,
    dismiss(minimize = false) {
      const w = [...wins.values()].find((w) => shown(w) && w.node.classList.contains('focus'));
      if (!w) return;
      Promise.resolve(minimize ? setMinimized(w.panel.id, true) : requestClose(w.panel.id)).catch((e) => ctx.toast(e.message, 'bad'));
    },
    // Leader u: restore the most recently minimized popup of this workspace; false when there is none.
    restoreNext() {
      if (isViewOnly()) return false;
      const p = pickRestore([...wins.values()].map((w) => w.panel), minOrder, current); if (!p) return false;
      setMinimized(p.id, false).catch((e) => ctx.toast(e.message, 'bad')); return true;
    },
    restore: (id) => setMinimized(id, false), minimize: (id) => setMinimized(id, true),
    close: requestClose, hasUnsavedChanges: () => [...wins.values()].some((w) => w.view.isDirty?.()),
    focusDirection, focusedTransparency, setTransparency, moveFocused, resizeFocused, focusNumber, focusNext, toggleMaximize, showNumbers, selectableIds, startSelection, selectWindow, moveSelection, activate, setWorkspace, workspaces, current: () => current,
    // a window was just opened live (not from a snapshot): unfold the dock when it is docked
    revealDock(id) { const w = wins.get(id); if (w && w.panel.placement === 'dock' && !w.panel.minimized && w.panel.autoFocus !== false) { openDock(); paintChips(); paintDock(); } },
    refresh() { paintChips(); paintDock(); },
    upsert, remove, get: (id) => wins.get(id),
    widgetChanged(info) { for (const w of wins.values()) w.view.widgetChanged?.(info); },
    all: () => [...wins.values()].map((w) => w.panel),
  };
}
