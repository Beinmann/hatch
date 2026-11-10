// Claude plan limits (5-hour and weekly windows) in the header. Hidden when the Claude CLI is not available.
const EVERY_MS = 2 * 60 * 1000; // the server caches and only runs the CLI now and then; this just re-reads it

export function initLimits({ el, api, toast, node }) {
  let timer = null; let last = null; let pop = null;
  const resetIn = (iso) => {
    const ms = Date.parse(iso) - Date.now();
    if (!(ms > 0)) return 'resets soon';
    const m = Math.round(ms / 60000);
    return m < 90 ? `resets in ${m} min` : m < 48 * 60 ? `resets in ${Math.round(m / 60)} h` : `resets in ${Math.round(m / 1440)} d`;
  };
  const when = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const closePop = () => { pop?.remove(); pop = null; };
  function openPop() {
    closePop();
    const c = last?.claude; if (!c || c.error) return;
    const rows = ['fiveHour', 'sevenDay'].filter((k) => c[k]).map((k) => {
      const w = c[k]; const pct = Math.round(w.percent);
      return el('div', { class: 'limpop-row' },
        el('div', { class: 'limpop-h' }, el('b', {}, w.label || (k === 'fiveHour' ? '5-hour' : 'Weekly')), el('span', {}, `${pct}% used`)),
        w.resetsAt ? el('div', { class: 'muted' }, `Resets ${resetIn(w.resetsAt).replace('resets ', '')} (${when(w.resetsAt)})`) : null);
    });
    const r = node.getBoundingClientRect();
    pop = el('div', { class: 'menu limpop', style: `position:fixed;top:${Math.round(r.bottom + 4)}px;right:${Math.max(8, Math.round(innerWidth - r.right))}px` },
      el('strong', {}, 'Claude plan limits'), ...rows,
      c.stale ? el('div', { class: 'w' }, `Showing older data: ${c.stale}`) : null,
      el('button', { type: 'button', onclick: () => refresh(true).then(openPop) }, 'Refresh'));
    document.body.append(pop);
  }
  document.addEventListener('pointerdown', (e) => { if (pop && !pop.contains(e.target) && !node.contains(e.target)) closePop(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
  function paint(data) {
    last = data;
    const c = data?.claude;
    node.replaceChildren();
    if (!c || c.error) { node.hidden = true; node.title = c?.error || ''; return; }
    node.hidden = false;
    node.append(...['fiveHour', 'sevenDay'].filter((k) => c[k]).map((k) => {
      const w = c[k]; const pct = Math.round(w.percent);
      return el('span', { class: `lim${pct >= 90 ? ' hot' : pct >= 70 ? ' warm' : ''}`, title: `${w.label} limit: ${pct}% used${w.resetsAt ? `, ${resetIn(w.resetsAt)}` : ''}` },
        el('span', { class: 'lim-k' }, k === 'fiveHour' ? '5h' : 'week'),
        el('span', { class: 'lim-bar' }, el('i', { style: `width:${Math.min(100, Math.max(0, pct))}%` })),
        el('span', { class: 'lim-v' }, `${pct}%`));
    }));
    node.title = `Claude plan limits (click for details)${c.stale ? `\nShowing older data: ${c.stale}` : ''}`;
  }
  async function refresh(force = false) {
    try { paint(await api('GET', `/api/limits${force ? '?refresh=1' : ''}`)); } catch (e) { paint({ claude: { error: e.message } }); }
  }
  node.addEventListener('click', () => (pop ? closePop() : openPop()));
  return {
    start() { refresh(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) refresh(); }, EVERY_MS); },
    refresh: async () => { await refresh(true); toast(node.hidden ? `Claude limits unavailable: ${node.title}` : 'Claude limits refreshed'); },
  };
}
