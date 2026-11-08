import { el, isViewOnly } from '../util.js';
import { renderMarkdown } from '../md.js';

// Double-click edits; Ctrl+Enter or leaving the note saves. Failed/conflicting saves retain the draft.
export default {
  create(panel, ctx) {
    const root = el('div', { class: 'note', title: isViewOnly() ? 'View-only note' : 'Double-click to edit' });
    let current = panel; let editing = false; let destroyed = false; let saving = false; let checking = false;
    let draft; let base = ''; let pending = null; let saveBtn; let cancelBtn; let status;
    const dirty = () => editing && (draft.value !== base || (current.props.markdown !== base && draft.value !== current.props.markdown));
    const runningBlocks = new Set();
    const SHELL = /^lang-(sh|bash|shell|zsh|console)$/;
    const wireRuns = () => root.querySelectorAll('pre > code').forEach((code) => {
      if (![...code.classList].some((c) => SHELL.test(c))) return;
      const pre = code.parentElement; pre.style.position = 'relative';
      const text = code.textContent.replace(/^\$ /gm, '');
      const cwd = ctx.cwd(); const key = `${cwd}\0${text}`;
      const button = el('button', { type: 'button', title: 'Run this block in an output window', disabled: isViewOnly() || runningBlocks.has(key), style: 'position:absolute;right:6px;top:6px;padding:0 8px', onclick: async () => {
        if (destroyed || isViewOnly() || runningBlocks.has(key)) return;
        runningBlocks.add(key); button.disabled = true;
        try {
          const r = await ctx.api('POST', '/api/runs', { cmd: text, cwd });
          if (!destroyed) await ctx.api('POST', '/api/panels', { type: 'output', title: text.split('\n')[0].slice(0, 40), props: { cmd: text, runId: r.id, cwd }, w: 560, h: 300 });
        } catch (e) { if (!destroyed) ctx.toast(e.message, 'bad'); }
        finally { runningBlocks.delete(key); if (!destroyed && !editing) render(); }
      } }, '▶ Run');
      pre.append(button);
    });
    const wireChecks = () => root.querySelectorAll('input[type=checkbox]').forEach((box, n) => {
      box.disabled = checking || isViewOnly(); box.style.cursor = 'pointer';
      box.addEventListener('change', async () => {
        if (destroyed || isViewOnly() || checking) return;
        const original = current.props.markdown; let i = -1; let fenced = false;
        const markdown = original.split('\n').map((line) => {
          if (/^\s*```/.test(line)) { fenced = !fenced; return line; }
          if (fenced) return line;
          return line.replace(/^((?:>\s?)*\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](?=\s+\S)/, (m, prefix) => (++i === n ? `${prefix}[${box.checked ? 'x' : ' '}]` : m));
        }).join('\n');
        checking = true; for (const input of root.querySelectorAll('input')) input.disabled = true;
        try {
          const p = await ctx.patch(current.id, { props: { markdown }, ifMarkdown: original });
          if (!destroyed && current.props.markdown === original) current = p?.props ? p : { ...current, props: { ...current.props, markdown } };
        } catch (e) { if (!destroyed) ctx.toast(e.message, 'bad'); }
        finally { checking = false; if (!destroyed && !editing) render(); }
      });
    });
    const render = () => { root.innerHTML = renderMarkdown(current.props.markdown); wireChecks(); wireRuns(); };
    const cancel = () => { if (saving || destroyed) return; editing = false; draft = null; render(); };
    const save = () => {
      if (destroyed || !editing || saving) return pending;
      const sent = draft.value;
      if (sent === current.props.markdown) { cancel(); return; }
      if (sent === base) { status.textContent = 'Note changed elsewhere; copy your draft or Cancel to view the latest note.'; return; }
      saving = true; saveBtn.disabled = cancelBtn.disabled = true; status.textContent = 'Saving…';
      pending = (async () => {
        try {
          const p = await ctx.patch(current.id, { props: { markdown: sent }, ifMarkdown: base });
          if (destroyed) return;
          // A newer remote update may have arrived after this save's event but before its HTTP response.
          if (current.props.markdown === base || current.props.markdown === sent) current = p?.props ? p : { ...current, props: { ...current.props, markdown: sent } };
          base = sent;
          if (draft.value === sent && current.props.markdown === sent) { editing = false; draft = null; render(); }
          else status.textContent = current.props.markdown === sent ? 'Saved; newer edits are still unsaved.' : 'Note changed elsewhere; your draft is kept. Copy it or cancel to view the latest note.';
        } catch (e) { if (!destroyed) { status.textContent = `${e.message}. Your draft is kept; retry Save or copy it before cancelling.`; ctx.toast(e.message, 'bad'); } }
        finally { saving = false; pending = null; if (!destroyed && editing) saveBtn.disabled = cancelBtn.disabled = false; }
      })();
      return pending;
    };
    root.addEventListener('dblclick', (event) => {
      if (destroyed || isViewOnly() || editing || checking || event.target.closest('button,input,a')) return;
      editing = true; base = current.props.markdown;
      draft = el('textarea', { class: 'editarea', style: 'width:100%;min-height:120px;flex:1', spellcheck: 'false', 'aria-label': 'Note markdown' });
      draft.value = base;
      status = el('div', { class: 'muted small', role: 'status' });
      // Keep focus in the textarea on press: browsers that don't focus buttons give blur a null relatedTarget, which saved before Cancel ran.
      const keepFocus = (e) => e.preventDefault();
      saveBtn = el('button', { type: 'button', onmousedown: keepFocus, onclick: save }, 'Save');
      cancelBtn = el('button', { type: 'button', onmousedown: keepFocus, onclick: cancel }, 'Cancel');
      root.replaceChildren(el('div', { style: 'display:flex;flex-direction:column;height:100%;gap:6px' }, draft, status, el('div', {}, saveBtn, cancelBtn)));
      draft.focus();
      draft.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
      });
      draft.addEventListener('blur', (e) => { if (!root.contains(e.relatedTarget)) save(); });
    });
    render();
    return {
      el: root, isDirty: dirty, focus() { draft?.focus(); },
      update(p) { current = p; if (!editing) render(); },
      async beforeClose() { if (pending) await pending; return !dirty() || window.confirm('Discard unsaved note changes?'); },
      destroy() { destroyed = true; },
    };
  },
};
