// editor panel: a plain textarea over a text file. Ctrl+S saves; saving refuses if the file changed on disk meanwhile.
import { el, isViewOnly } from '../util.js';
import { renderMarkdown } from '../md.js';

// Preview kinds by file extension: markdown renders, JSON is pretty-printed, CSV/TSV becomes a table.
const previewKind = (p) => (/\.(md|markdown)$/i.test(p) ? 'md' : /\.json$/i.test(p) ? 'json' : /\.(csv|tsv)$/i.test(p) ? 'csv' : null);
function parseCsv(text, delim) { // handles quoted fields, doubled quotes and newlines inside quotes
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export default {
  create(panel, ctx) {
    if (isViewOnly()) return { el: el('div', { class: 'muted pad' }, 'File contents are unavailable in view-only mode.'), update() {}, destroy() {} };
    const path = () => panel.props.path;
    const ta = el('textarea', { spellcheck: 'false', class: 'editarea', 'aria-label': 'File contents' });
    const status = el('span', { class: 'muted small' }, 'loading...');
    let mtime; let saved = ''; let crlf = false; // a textarea turns CRLF into LF; remember and restore it on save
    let loaded = false; let loading = false; let saving = false; let destroyed = false; let revision = 0; let checking = false;
    const dirty = () => loaded && ta.value !== saved;
    const paint = () => {
      ta.disabled = loading || !loaded;
      saveBtn.disabled = loading || saving || !loaded;
      reloadBtn.disabled = loading || saving;
      if (loading) status.textContent = `loading...  ${path()}`;
      else if (saving) status.textContent = `saving...  ${path()}`;
      else if (loaded) status.textContent = `${dirty() ? '● modified' : 'saved'}  ${path()}`;
    };
    const save = async () => {
      if (destroyed || !loaded || loading || saving) return;
      saving = true; revision++; paint();
      const sent = ta.value; // keystrokes typed during the request stay unsaved
      try {
        const r = await ctx.api('PUT', '/api/fs/write', { path: path(), text: crlf ? sent.replace(/\n/g, '\r\n') : sent, mtime });
        if (destroyed) return;
        mtime = r.mtime; saved = sent; ctx.toast(`Saved ${path().split('/').pop()}`);
      } catch (e) { if (!destroyed) ctx.toast(e.message, 'bad', 8000); }
      finally { saving = false; if (!destroyed) paint(); }
    };
    const load = async () => {
      if (destroyed || loading || saving) return;
      if (dirty() && !window.confirm(`Discard unsaved changes to ${path().split('/').pop()} and reload?`)) return;
      loading = true; revision++; paint();
      let error;
      try {
        const r = await ctx.api('GET', `/api/fs/read?path=${encodeURIComponent(path())}`);
        if (destroyed) return;
        crlf = r.text.includes('\r\n'); ta.value = r.text; saved = ta.value; mtime = r.mtime; loaded = true;
        if (!view.hidden) showPreview();
      } catch (e) { error = e.message; }
      finally {
        loading = false;
        if (!destroyed) { paint(); if (error) status.textContent = error; else goLine(panel.props.line); }
      }
    };
    // props.line (from a path:line reference): put the caret on that line and scroll it into view
    const goLine = (n) => {
      if (!n || n < 1) return;
      const lines = ta.value.split('\n'); const start = lines.slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0);
      ta.focus(); ta.setSelectionRange(start, start + (lines[n - 1] || '').length);
      ta.scrollTop = Math.max(0, (n - 4) * parseFloat(getComputedStyle(ta).lineHeight || 19));
    };
    ta.addEventListener('input', paint);
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
      else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); document.execCommand('insertText', false, '  '); } // keep indentation typing in a plain textarea
      e.stopPropagation();
    });
    const kind = previewKind(panel.props.path);
    const view = el('div', { class: 'note', hidden: true, style: 'flex:1;overflow:auto' });
    const showPreview = () => {
      view.replaceChildren();
      if (kind === 'md') view.innerHTML = renderMarkdown(ta.value); // md.js escapes before adding markup
      else if (kind === 'json') { let t; try { t = JSON.stringify(JSON.parse(ta.value), null, 2); } catch (e) { t = `Not valid JSON: ${e.message}`; } view.append(el('pre', {}, t)); }
      else if (kind === 'csv') {
        const rows = parseCsv(ta.value, /\.tsv$/i.test(panel.props.path) ? '\t' : ',').slice(0, 2000);
        view.append(el('table', {}, ...rows.map((r, i) => el('tr', {}, ...r.map((c) => el(i === 0 ? 'th' : 'td', {}, c))))));
      }
    };
    const previewBtn = kind ? el('button', { type: 'button', title: 'Toggle a rendered preview', onclick: () => { const on = view.hidden; view.hidden = !on; ta.hidden = on; previewBtn.classList.toggle('on', on); if (on) showPreview(); } }, 'Preview') : null;
    const reloadBtn = el('button', { type: 'button', onclick: load, title: 'Discard changes and reload from disk' }, 'Reload');
    const saveBtn = el('button', { type: 'button', onclick: save }, 'Save');
    const root = el('div', { style: 'display:flex;flex-direction:column;height:100%' }, ta, view,
      el('div', { class: 'cap', style: 'display:flex;gap:8px;align-items:center;padding:4px 8px;border-top:1px solid var(--line)' }, el('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, status),
        ...(previewBtn ? [previewBtn] : []), reloadBtn, saveBtn));
    // Auto-revert (Emacs auto-revert-mode): when the file changes on disk and the window has no unsaved edits, reload it.
    const watch = setInterval(async () => {
      if (destroyed || checking || loading || saving || !loaded || dirty() || !root.offsetParent) return;
      checking = true; const request = revision;
      try {
        const r = await ctx.api('GET', `/api/fs/read?path=${encodeURIComponent(path())}`);
        if (destroyed || request !== revision || loading || saving || r.mtime === mtime || dirty()) return;
        const pos = ta.selectionStart;
        crlf = r.text.includes('\r\n'); ta.value = r.text; saved = ta.value; mtime = r.mtime;
        try { ta.setSelectionRange(pos, pos); } catch { /* ignore */ }
        paint(); if (!view.hidden) showPreview(); status.textContent += '  (reloaded: changed on disk)';
      } catch { /* deleted or unreadable: keep what is shown */ }
      finally { checking = false; }
    }, 3000);
    load();
    return { el: root, isDirty: dirty, beforeClose: () => !dirty() || window.confirm(`Discard unsaved changes to ${path().split('/').pop()}?`), focus() { ta.focus(); }, update(p) { if (p.props.line && p.props.line !== panel.props.line) { panel = p; goLine(p.props.line); } }, destroy() { destroyed = true; revision++; clearInterval(watch); } };
  },
};
