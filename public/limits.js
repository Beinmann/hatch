// Claude plan limits (5-hour and weekly windows) in the header. Hidden when the Claude CLI is not available.
const EVERY_MS = 2 * 60 * 1000; // the server caches and only runs the CLI now and then; this just re-reads it

export function initLimits({ el, api, toast, node }) {
  let timer = null;
  const resetIn = (iso) => {
    const ms = Date.parse(iso) - Date.now();
    if (!(ms > 0)) return 'resets soon';
    const m = Math.round(ms / 60000);
    return m < 90 ? `resets in ${m} min` : m < 48 * 60 ? `resets in ${Math.round(m / 60)} h` : `resets in ${Math.round(m / 1440)} d`;
  };
  function paint(data) {
    const c = data?.claude;
    node.replaceChildren();
    if (!c || c.error) { node.hidden = true; node.title = c?.error || ''; return; }
    node.hidden = false;
    node.append(...['fiveHour', 'sevenDay'].filter((k) => c[k]).map((k) => {
      const w = c[k]; const pct = Math.round(w.percent);
      return el('span', { class: `lim${pct >= 90 ? ' hot' : pct >= 70 ? ' warm' : ''}`, title: `${w.label} limit: ${pct}% used${w.resetsAt ? `, ${resetIn(w.resetsAt)}` : ''}` },
        `${k === 'fiveHour' ? '5h' : 'wk'} ${pct}%${k === 'fiveHour' && w.resetsAt ? ` · ${resetIn(w.resetsAt)}` : ''}`);
    }));
    node.title = `Claude plan limits (click to refresh)${c.stale ? `\nShowing older data: ${c.stale}` : ''}`;
  }
  async function refresh(force = false) {
    try { paint(await api('GET', `/api/limits${force ? '?refresh=1' : ''}`)); } catch (e) { paint({ claude: { error: e.message } }); }
  }
  node.addEventListener('click', () => refresh(true));
  return {
    start() { refresh(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) refresh(); }, EVERY_MS); },
    refresh: async () => { await refresh(true); toast(node.hidden ? `Claude limits unavailable: ${node.title}` : 'Claude limits refreshed'); },
  };
}
