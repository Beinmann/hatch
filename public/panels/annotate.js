// Image annotation: draw a pen, rectangles and arrows over an image, then save the result as a new upload.
// Everything is drawn on one canvas at the image's natural size; the shapes are kept as a list so Undo is exact.
import { el } from '../util.js';

const COLORS = ['#ef4444', '#facc15', '#22c55e', '#38bdf8'];

export function createAnnotator({ img, onSave, onCancel, onError = () => {} }) {
  const cv = el('canvas', { style: 'max-width:100%;max-height:100%;touch-action:none;cursor:crosshair' });
  const ctx = cv.getContext('2d');
  const shapes = []; let draft = null; let tool = 'pen'; let color = COLORS[0];
  const lw = () => Math.max(3, Math.round(cv.width / 220)); // line width that stays visible on big screenshots

  function arrow(g, x1, y1, x2, y2) {
    const a = Math.atan2(y2 - y1, x2 - x1); const h = lw() * 5;
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    g.beginPath(); g.moveTo(x2, y2); g.lineTo(x2 - h * Math.cos(a - 0.45), y2 - h * Math.sin(a - 0.45)); g.lineTo(x2 - h * Math.cos(a + 0.45), y2 - h * Math.sin(a + 0.45)); g.closePath(); g.fillStyle = g.strokeStyle; g.fill();
  }
  function draw(s) {
    ctx.strokeStyle = s.color; ctx.lineWidth = lw(); ctx.lineCap = ctx.lineJoin = 'round';
    if (s.type === 'pen') { ctx.beginPath(); s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); }
    else if (s.type === 'rect') ctx.strokeRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1);
    else if (s.type === 'arrow') arrow(ctx, s.x1, s.y1, s.x2, s.y2);
  }
  function redraw() { ctx.drawImage(img, 0, 0, cv.width, cv.height); for (const s of shapes) draw(s); if (draft) draw(draft); }
  const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * (cv.width / r.width), (e.clientY - r.top) * (cv.height / r.height)]; };

  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId); const [x, y] = pos(e);
    draft = tool === 'pen' ? { type: 'pen', color, pts: [[x, y]] } : { type: tool, color, x1: x, y1: y, x2: x, y2: y };
  });
  cv.addEventListener('pointermove', (e) => {
    if (!draft) return; const [x, y] = pos(e);
    if (draft.type === 'pen') draft.pts.push([x, y]); else { draft.x2 = x; draft.y2 = y; }
    redraw();
  });
  const end = () => { if (!draft) return; shapes.push(draft); draft = null; redraw(); };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);

  const btn = (label, fn, title) => el('button', { type: 'button', title, onclick: fn }, label);
  const toolBtns = ['pen', 'rect', 'arrow'].map((t) => { const b = btn(t === 'rect' ? 'box' : t, () => { tool = t; toolBtns.forEach((x) => x.classList.toggle('on', x === b)); }, `Draw with the ${t}`); if (t === tool) b.classList.add('on'); return b; });
  const swatches = COLORS.map((c) => { const b = el('button', { type: 'button', title: c, 'aria-label': `Colour ${c}`, style: `background:${c};width:22px;padding:0`, onclick: () => { color = c; swatches.forEach((x) => { x.style.outline = x === b ? '2px solid var(--fg)' : ''; }); } }); if (c === color) b.style.outline = '2px solid var(--fg)'; return b; });
  let saving = false;
  const saveButton = btn('Save and paste path', () => {
    if (saving) return;
    saving = true; saveButton.textContent = 'Saving…'; bar.setAttribute('aria-busy', 'true');
    const buttons = [...bar.querySelectorAll('button')]; buttons.forEach((b) => { b.disabled = true; }); cv.style.pointerEvents = 'none';
    const finish = () => { saving = false; saveButton.textContent = 'Save and paste path'; bar.removeAttribute('aria-busy'); buttons.forEach((b) => { b.disabled = false; }); cv.style.pointerEvents = ''; };
    try { cv.toBlob(async (blob) => { try { await onSave(blob); } catch (e) { onError(e); } finally { finish(); } }, 'image/png'); }
    catch (e) { finish(); onError(e); }
  }, 'Save as a new upload and type its path into the terminal');
  const bar = el('div', { class: 'cap', style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap' }, ...toolBtns, ...swatches,
    btn('Undo', () => { shapes.pop(); redraw(); }, 'Remove the last mark'),
    el('span', { style: 'flex:1' }),
    btn('Cancel', () => onCancel(), 'Discard the marks'),
    saveButton);
  const root = el('div', { class: 'imgview' }, el('div', { class: 'stage' }, cv), bar);

  function init() { cv.width = img.naturalWidth; cv.height = img.naturalHeight; redraw(); }
  if (img.complete && img.naturalWidth) init(); else img.addEventListener('load', init, { once: true });
  return { el: root, count: () => shapes.length + (draft ? 1 : 0) };
}
