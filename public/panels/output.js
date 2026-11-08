// output window (Emacs compilation-mode idea): live output of `hatch run`, exit status, Rerun and Stop.
// `path:line` references become buttons that open the file in an editor window. Colours are stripped.
import { el, isViewOnly } from '../util.js';
import { copyText } from '../terminal.js';
import { stripAnsi } from '../ansi.js';
import { streamSlots } from '../stream-slots.js';

// Reject starts inside a path token, avoiding quadratic retries on long lines without a reference.
const REF = /(?<![\w.@+\/-])((?:\/|\.\.?\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z]{1,6}):(\d+)(?::\d+)?/g;
export const outputReferences = (line) => line.matchAll(REF);
const KEEP = 512 * 1024; // bound the browser buffer as well as the server's retained output
const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export default {
  create(panel, ctx) {
    const pre = el('pre', { class: 'outpre' });
    const status = el('span', { class: 'chip' }, 'starting');
    const stopBtn = el('button', { type: 'button', hidden: true }, 'Stop');
    const filter = el('input', { type: 'text', placeholder: 'filter lines', 'aria-label': 'Filter output lines', style: 'width:110px;padding:1px 5px;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg);font:12px var(--mono)' });
    const copyBtn = el('button', { type: 'button', title: 'Copy retained output' }, 'Copy');
    const rerunBtn = el('button', { type: 'button', hidden: isViewOnly() }, 'Rerun');
    const head = el('div', { class: 'cap', style: 'display:flex;gap:8px;align-items:center;padding:4px 8px;border-bottom:1px solid var(--line)' }, status, el('span', { class: 'muted small', style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', title: panel.props.cmd }, `$ ${panel.props.cmd}`), filter, copyBtn, stopBtn, rerunBtn);
    const truncated = el('div', { class: 'muted small pad', hidden: true }, 'Showing the latest output; earlier output was discarded.');
    const root = el('div', { style: 'display:flex;flex-direction:column;height:100%' }, head, truncated, el('div', { style: 'flex:1;overflow:auto', class: 'outwrap' }, pre));
    let es = null; let lease = null; let runId = panel.props.runId; let text = ''; let destroyed = false; let revision = 0; let rerunning = false; let frame = 0;
    const wrap = root.querySelector('.outwrap');

    const paint = () => {
      const stick = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 30;
      let clean = stripAnsi(text).replace(/\r(?!\n)/g, '\n');
      const f = filter.value.trim().toLowerCase(); if (f) clean = clean.split('\n').filter((l) => l.toLowerCase().includes(f)).join('\n');
      const frag = document.createDocumentFragment();
      // diff windows colour added/removed lines; every window links path:line references
      const lines = panel.props.kind === 'diff' ? clean.split('\n') : [clean];
      lines.forEach((line, i) => {
        const holder = panel.props.kind === 'diff' ? el('div', { class: /^\+(?!\+\+)/.test(line) ? 'dadd' : /^-(?!--)/.test(line) ? 'ddel' : /^@@/.test(line) ? 'dhunk' : /^(diff |index |\+\+\+|---)/.test(line) ? 'dmeta' : '' }) : frag;
        let last = 0;
        for (const m of outputReferences(line)) {
          holder.append(line.slice(last, m.index));
          holder.append(el(isViewOnly() ? 'span' : 'a', { href: isViewOnly() ? null : '#', class: 'ref', title: 'Open in an editor window', onclick: (e) => { e.preventDefault(); openRef(m[1], Number(m[2])); } }, m[0]));
          last = m.index + m[0].length;
        }
        holder.append(line.slice(last) || (holder === frag ? '' : '\u200b'));
        if (holder !== frag) frag.append(holder);
      });
      pre.replaceChildren(frag);
      if (stick) wrap.scrollTop = wrap.scrollHeight;
    };
    const openRef = (p, line) => {
      if (isViewOnly()) return;
      const base = panel.props.cwd || ctx.cwd(); const full = p.startsWith('/') ? p : `${base}/${p.replace(/^\.\//, '')}`;
      ctx.api('POST', '/api/panels', { type: 'editor', title: full.split('/').pop(), props: { path: full, ...(line && { line }) }, w: 560, h: 380 }).catch((e) => ctx.toast(e.message, 'bad'));
    };
    const setStatus = (t, cls) => { status.textContent = t; status.className = `chip ${cls || ''}`; };
    const queuePaint = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (!destroyed) paint(); });
    };
    const retain = () => {
      if (text.length > KEEP) {
        text = text.slice(-KEEP);
        if (/^[\uDC00-\uDFFF]/.test(text)) text = text.slice(1); // never split a decoded surrogate pair
        truncated.hidden = false;
      }
      queuePaint();
    };
    function stop() { es?.close(); es = null; lease?.release(); lease = null; }
    function connect() {
      revision++; stop(); text = ''; pre.textContent = ''; truncated.hidden = true;
      stopBtn.hidden = true; stopBtn.disabled = false; stopBtn.textContent = 'Stop';
      if (!runId) { setStatus('no run', 'bad'); return; }
      setStatus('running', 'warn'); stopBtn.hidden = isViewOnly();
      setStatus('waiting for a free connection', 'warn');
      lease = streamSlots.acquire(() => { if (destroyed) stop(); else open(); }); // see stream-slots.js
    }
    function open() {
      setStatus('running', 'warn');
      const source = new EventSource(`/api/runs/${runId}/stream`); es = source;
      const current = () => !destroyed && es === source;
      let dec = new TextDecoder();
      source.addEventListener('truncated', () => { if (current()) truncated.hidden = false; });
      source.addEventListener('replay', (m) => {
        if (!current()) return;
        // Replay is a fresh snapshot after reconnecting, independent of partial bytes from the old connection.
        dec = new TextDecoder(); text = dec.decode(bytes(m.data), { stream: true }); retain();
      });
      source.onmessage = (m) => { if (current()) { text += dec.decode(bytes(m.data), { stream: true }); retain(); } };
      source.addEventListener('exit', (m) => {
        if (!current()) return;
        text += dec.decode(); retain(); stop(); stopBtn.hidden = true;
        setStatus(m.data === '0' ? 'done (exit 0)' : `failed (exit ${m.data})`, m.data === '0' ? 'ok' : 'bad');
      });
      source.onerror = () => {
        if (current() && source.readyState === EventSource.CLOSED) { stop(); setStatus('run not available (server restarted?)', 'bad'); stopBtn.hidden = true; }
      };
    }
    filter.addEventListener('input', paint); filter.addEventListener('keydown', (e) => e.stopPropagation());
    copyBtn.addEventListener('click', async () => {
      const copied = await copyText(stripAnsi(text));
      if (!destroyed) ctx.toast(copied ? 'Output copied' : 'Copy failed', 'info');
    });
    stopBtn.addEventListener('click', async () => {
      if (destroyed || isViewOnly() || stopBtn.disabled || !runId) return;
      const request = revision; stopBtn.disabled = true; let stopping = false;
      try {
        const run = await ctx.api('DELETE', `/api/runs/${runId}`); stopping = !!run?.stopping;
        if (!destroyed && request === revision && stopping) stopBtn.textContent = 'Stopping…';
      }
      catch (e) { if (!destroyed && request === revision) ctx.toast(e.message, 'bad'); }
      finally { if (!destroyed && request === revision) stopBtn.disabled = stopping; }
    });
    rerunBtn.addEventListener('click', async () => {
      if (destroyed || isViewOnly() || rerunning) return;
      rerunning = true; rerunBtn.disabled = true; const request = revision;
      try {
        const r = await ctx.api('POST', '/api/runs', { cmd: panel.props.rerun || panel.props.cmd, cwd: panel.props.cwd });
        if (destroyed || request !== revision) return;
        runId = r.id; connect();
        await ctx.patch(panel.id, { props: { runId } });
      } catch (e) { if (!destroyed) ctx.toast(e.message, 'bad'); }
      finally { rerunning = false; if (!destroyed) rerunBtn.disabled = false; }
    });
    connect();
    return { el: root, update(p) { panel = p; if (p.props.runId && p.props.runId !== runId) { runId = p.props.runId; connect(); } }, destroy() { destroyed = true; revision++; stop(); cancelAnimationFrame(frame); } };
  },
};
