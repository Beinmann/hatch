// Progress is a connected journey of steps. Mermaid and its history remain available on demand.
import { el } from '../util.js';

let mermaidReady = null;
function loadMermaid() { // vendored, loaded only when a progress panel opens
  mermaidReady ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/mermaid.min.js';
    s.onload = () => {
      // follow the page's actual brightness (custom.css may differ from the system setting)
      const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(getComputedStyle(document.body).backgroundColor || ''); const dark = m ? (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) < 128 : matchMedia('(prefers-color-scheme: dark)').matches;
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
      resolve(window.mermaid);
    };
    s.onerror = () => { mermaidReady = null; s.remove(); reject(new Error('could not load /vendor/mermaid.min.js; reopen the diagram to retry')); };
    document.head.append(s);
  });
  return mermaidReady;
}

let counter = 0;
// A newer request owns the target even while the old Mermaid render is still awaiting completion.
const renders = new WeakMap();
function invalidateDiagram(target) { renders.set(target, (renders.get(target) || 0) + 1); }
/** Shows the latest requested diagram; parse failures preserve its last successful rendering. */
export async function renderDiagram(source, target) {
  invalidateDiagram(target);
  const revision = renders.get(target); const current = () => renders.get(target) === revision;
  if (!source.trim()) {
    delete target.dataset.good;
    target.replaceChildren(el('span', { class: 'muted' }, 'No diagram yet. Claude can set one with: hatch progress set diagram.mmd'));
    return;
  }
  let mermaid;
  try { mermaid = await loadMermaid(); }
  catch (e) { if (current()) target.replaceChildren(el('div', { class: 'err' }, e.message), el('pre', {}, source)); return; }
  if (!current()) return;
  const id = `mmd${++counter}`;
  try {
    const { svg } = await mermaid.render(id, source);
    if (!current()) return;
    target.innerHTML = svg; // mermaid runs with securityLevel strict
    target.dataset.good = '1';
  } catch (e) {
    document.getElementById(`d${id}`)?.remove(); // remove only this render's error scraps
    if (!current()) return;
    const msg = el('div', { class: 'err' }, `Diagram error: ${String(e.message || e).split('\n')[0]}`);
    const raw = el('details', {}, el('summary', {}, 'source'), el('pre', {}, source));
    const error = el('div', { class: 'diagram-error' }, msg, raw);
    target.querySelector(':scope > .diagram-error')?.remove();
    if (target.dataset.good) target.prepend(error); else target.replaceChildren(error);
  }
}

const statuses = ['todo', 'running', 'done', 'blocked', 'skipped'];
export function progressSummary(steps = []) {
  const done = steps.filter((s) => s.status === 'done').length;
  const skipped = steps.filter((s) => s.status === 'skipped').length;
  const current = steps.find((s) => s.status === 'blocked') || steps.find((s) => s.status === 'running') || steps.find((s) => s.status === 'todo');
  return { done, skipped, total: steps.length, current, percent: steps.length ? Math.round((done + skipped) / steps.length * 100) : 0 };
}

export default {
  create(panel, ctx) {
    const dia = el('div', { class: 'dia' });
    const list = el('div', { class: 'journey' });
    const heading = el('strong'); const count = el('span', { class: 'muted small' });
    const meter = el('div', { class: 'progress-meter', role: 'progressbar', 'aria-label': 'Steps finished', 'aria-valuemin': '0', 'aria-valuemax': '100' }, el('span'));
    const overview = el('div', { class: 'progress-overview' }, el('div', { class: 'progress-heading' }, heading, count), meter);
    const diagramDetails = el('details', { class: 'diagram-details' }, el('summary', {}, 'Diagram & history'));
    const expanded = new Set();
    diagramDetails.addEventListener('toggle', () => { if (diagramDetails.open && live && !scrubbing) { last = null; paint(live); } });
    // Timeline: progress/history/ keeps the previous diagrams; the slider scrubs back through them (read-only) and
    // the rightmost position is the live diagram.
    const slider = el('input', { type: 'range', min: '0', max: '0', value: '0', hidden: true, 'aria-label': 'Diagram history', style: 'flex:1' });
    const when = el('span', { class: 'muted small' }, 'live');
    const bar = el('div', { style: 'display:flex;gap:8px;align-items:center', hidden: true }, slider, when);
    diagramDetails.append(bar, dia);
    const root = el('div', { class: 'prog' }, overview, list, diagramDetails);
    let last = null; let hist = []; let live = null; let scrubbing = false; let selection = 0; let historyRequest = 0; let destroyed = false;
    const loadHistory = async () => {
      const request = ++historyRequest;
      let entries;
      try { entries = await ctx.api('GET', '/api/progress/history'); } catch { return; }
      if (destroyed || request !== historyRequest) return;
      hist = entries;
      slider.max = String(hist.length); if (!scrubbing) slider.value = String(hist.length);
      bar.hidden = slider.hidden = !hist.length;
      diagramDetails.hidden = !live?.diagram && !hist.length;
    };
    slider.addEventListener('input', async () => {
      const request = ++selection;
      invalidateDiagram(dia);
      const i = Number(slider.value);
      const name = hist[i];
      if (i >= hist.length) { scrubbing = false; when.textContent = 'live'; if (live) { last = null; paint(live); } return; }
      scrubbing = true; when.textContent = name.replace(/\.mmd$/, '').replace(/T(\d\d)-(\d\d)-(\d\d).*/, ' $1:$2:$3');
      try {
        const src = await ctx.api('GET', `/api/progress/history/${name}`);
        if (!destroyed && request === selection && scrubbing) { last = `history:${name}`; renderDiagram(src, dia); }
      } catch (e) { if (!destroyed && request === selection) ctx.toast(e.message, 'bad'); }
    });
    const paint = (p) => {
      live = p;
      if (diagramDetails.open && !scrubbing && p.diagram !== last) { last = p.diagram; renderDiagram(p.diagram, dia); loadHistory(); }
      const summary = progressSummary(p.steps);
      heading.textContent = summary.current?.status === 'blocked' ? 'Needs attention' : summary.current ? 'Work in progress' : summary.total ? 'Plan complete' : 'Ready for a plan';
      count.textContent = summary.total ? `${summary.done} done${summary.skipped ? ` · ${summary.skipped} skipped` : ''} / ${summary.total}` : '';
      meter.setAttribute('aria-valuenow', String(summary.percent)); meter.firstChild.style.width = `${summary.percent}%`;
      diagramDetails.hidden = !p.diagram && !hist.length;
      if (!p.steps.length) {
        list.replaceChildren(el('div', { class: 'progress-empty' }, el('p', {}, 'Break the work into small, visible steps.'), el('code', {}, 'hatch progress plan "Explore" "Build" "Verify"'), el('p', { class: 'muted small' }, 'An agent can update each step and add details as it works.')));
        return;
      }
      let group = null;
      list.replaceChildren(...p.steps.flatMap((s, i) => {
        const prefix = [];
        if (s.group && s.group !== group) prefix.push(el('div', { class: 'step-group' }, s.group));
        group = s.group || null;
        const select = el('select', { 'aria-label': `Status for ${s.title}`, disabled: document.body.classList.contains('viewonly'), onchange: async () => {
          select.disabled = true;
          try { await ctx.api('PATCH', `/api/progress/steps/${encodeURIComponent(s.id)}`, { status: select.value }); }
          catch (e) { ctx.toast(e.message, 'bad'); select.value = s.status; }
          finally { select.disabled = document.body.classList.contains('viewonly'); }
        } }, ...statuses.map((status) => el('option', { value: status, selected: s.status === status }, status)));
        const row = el('details', { class: `journey-step ${s.status}`, open: expanded.has(s.id) || (!expanded.has(`closed:${s.id}`) && ['running', 'blocked'].includes(s.status)) },
          el('summary', {}, el('span', { class: 'step-marker', 'aria-hidden': 'true' }, s.status === 'done' ? '✓' : s.status === 'blocked' ? '!' : s.status === 'skipped' ? '–' : i + 1), el('span', { class: 'step-title' }, s.title), el('span', { class: `st ${s.status}` }, s.status)),
          el('div', { class: 'step-detail' }, el('p', { class: s.detail ? '' : 'muted' }, s.detail || 'No additional details yet.'), el('div', { class: 'step-meta' }, select, el('span', { class: 'muted small' }, s.updated ? `Updated ${new Date(s.updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''))));
        row.addEventListener('toggle', () => { if (!row.isConnected) return; if (row.open) { expanded.add(s.id); expanded.delete(`closed:${s.id}`); } else { expanded.delete(s.id); expanded.add(`closed:${s.id}`); } });
        return [...prefix, row];
      }));
    };
    const off = ctx.onProgress(paint);
    paint(ctx.progress()); loadHistory();
    return { el: root, update() {}, destroy() { destroyed = true; selection++; invalidateDiagram(dia); off(); } };
  },
};
