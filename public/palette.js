// One searchable surface for commands, files and popups. Open immediately while remote entries load.
import { el } from './util.js';

const score = (label, q) => {
  const l = label.toLowerCase(); let i = 0; let last = -1; let gaps = 0;
  for (const ch of q) { const j = l.indexOf(ch, i); if (j < 0) return -1; if (last >= 0) gaps += j - last - 1; last = j; i = j + 1; }
  return 1000 - gaps - (l.startsWith(q) ? 0 : 50) - label.length;
};

export function createPalette({ entries, initialEntries = () => [], dynamic = () => [], usage = () => ({}), onUsed = () => {}, onClose = () => {}, onError = () => {} }) {
  let root = null; let previousFocus = null; let repaint = () => {};
  function close() {
    if (!root) return;
    root.remove(); root = null; repaint = () => {};
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null; onClose();
  }
  async function open() {
    if (root) return close();
    previousFocus = document.activeElement;
    const input = el('input', { type: 'text', placeholder: 'Search commands, /files, !shell…', 'aria-label': 'Command palette', role: 'combobox', 'aria-expanded': 'true', 'aria-autocomplete': 'list', 'aria-controls': 'palette-results', autocomplete: 'off', spellcheck: 'false' });
    const list = el('ul', { id: 'palette-results', role: 'listbox', 'aria-label': 'Commands', 'aria-busy': 'true' });
    const status = el('div', { class: 'palette-status muted small', role: 'status' }, 'Loading commands…');
    const help = el('div', { class: 'palette-help muted small' }, '↑↓ move · Enter open · Esc return', el('span', {}, '/ files · ! run · @ mention'));
    let all = initialEntries(); let used = usage(); let shown = []; let sel = 0; let loading = true;
    const highlight = () => {
      [...list.children].forEach((n, i) => { n.classList.toggle('on', i === sel); n.setAttribute('aria-selected', String(i === sel)); });
      if (shown[sel]) { input.setAttribute('aria-activedescendant', `palette-option-${sel}`); list.children[sel]?.scrollIntoView({ block: 'nearest' }); }
      else input.removeAttribute('aria-activedescendant');
    };
    const paint = () => {
      const q = input.value.trim().toLowerCase();
      const extra = dynamic(input.value);
      const sorted = q
        ? all.map((e) => [score(e.label, q), e]).filter(([s]) => s >= 0).map(([s, e]) => [s + Math.min(40, (used[e.label] || 0) * 4), e]).sort((a, b) => b[0] - a[0]).map(([, e]) => e)
        : [...all].sort((a, b) => (used[b.label] || 0) - (used[a.label] || 0));
      shown = [...extra, ...sorted].slice(0, 50);
      sel = Math.max(0, Math.min(sel, shown.length - 1));
      status.hidden = !!shown.length;
      status.textContent = loading ? 'Loading commands…' : 'No matching commands. Try /filename or !command.';
      list.replaceChildren(...shown.map((e, i) => el('li', { id: `palette-option-${i}`, role: 'option', onclick: () => run(e), onmousemove: () => { if (sel !== i) { sel = i; highlight(); } } }, el('span', {}, e.label), e.hint ? el('span', { class: 'muted small' }, e.hint) : null)));
      highlight();
    };
    const run = (e) => { close(); if (!e.dynamic) onUsed(e.label); Promise.resolve().then(() => e.run()).catch(onError); };
    input.addEventListener('input', () => { sel = 0; paint(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); sel = Math.max(0, Math.min(shown.length - 1, sel + 1)); highlight(); }
      else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); sel = Math.max(0, sel - 1); highlight(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (shown[sel]) run(shown[sel]); }
    });
    const session = el('div', { id: 'palette', onclick: (e) => { if (e.target === session) close(); } }, el('div', { class: 'box', role: 'dialog', 'aria-label': 'Command palette' }, input, list, status, help));
    root = session; repaint = paint;
    document.body.append(root); paint(); input.focus();
    try {
      const loaded = await entries();
      if (root !== session) return; // a slow response must never reopen a dismissed or newer palette
      all = loaded; loading = false; list.setAttribute('aria-busy', 'false'); paint();
    } catch (e) {
      if (root !== session) return;
      loading = false; list.setAttribute('aria-busy', 'false'); paint(); status.hidden = false; status.textContent = `Could not load commands: ${e.message}`;
    }
  }
  return { open, close, refresh: () => repaint(), isOpen: () => !!root };
}
