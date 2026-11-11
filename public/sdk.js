// Hatch widget SDK: a tiny wrapper around the postMessage protocol between a widget iframe and the page.
//   hatch.on('cpu', (value, ts) => ...)   subscribe to a source declared in widget.json
//   hatch.call('pick', 'a.jpg').then((value) => ...)   run an exec source once; the argument arrives as $HATCH_ARG
//   hatch.off('cpu')  hatch.resize(w, h)  hatch.log(text)  hatch.theme  hatch.ready(fn)
(() => {
  const handlers = {}; const readyFns = []; let initialised = false; const pending = new Map(); let nextId = 1;
  const post = (msg) => parent.postMessage(msg, '*');
  const hatch = {
    theme: {}, name: '', sources: [],
    on(source, fn) { (handlers[source] ||= []).push(fn); post({ type: 'subscribe', source }); },
    call(source, arg) {
      return new Promise((resolve, reject) => {
        const id = nextId++; pending.set(id, { resolve, reject });
        post({ type: 'call', id, source, ...(arg !== undefined && { arg: String(arg) }) });
      });
    },
    off(source) { delete handlers[source]; post({ type: 'unsubscribe', source }); },
    resize(w, h) { post({ type: 'resize', w, h }); },
    log(text) { post({ type: 'log', text: String(text) }); },
    ready(fn) { if (initialised) fn(); else readyFns.push(fn); },
  };
  // Slim themed scroll bars inside widgets, with a reserved gutter so the bar never covers content (right-aligned text
  // especially). Uses --muted from the host theme; a widget can override any of it with its own CSS.
  const sb = document.createElement('style');
  sb.textContent = '*{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--muted,#888) 55%,transparent) transparent}' +
    '*{scrollbar-gutter:stable}';
  (document.head || document.documentElement).prepend(sb);
  addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const m = e.data || {};
    if (m.type === 'init') {
      hatch.theme = m.theme || {}; leader = m.leader || null; hatch.name = m.name; hatch.sources = m.sources || [];
      const r = document.documentElement.style;
      for (const [k, v] of Object.entries(hatch.theme)) r.setProperty(`--${k}`, v);
      initialised = true; readyFns.splice(0).forEach((f) => f());
    } else if (m.type === 'hatch-take-focus') {
      window.focus();
    } else if (m.type === 'hatch-leader') {
      armed = !!m.armed;
    } else if (m.type === 'result') {
      const p = pending.get(m.id); pending.delete(m.id);
      if (p) { if (m.error) p.reject(new Error(m.error)); else p.resolve(m.value); }
    } else if (m.type === 'data') {
      for (const f of handlers[m.source] || []) { try { f(m.value, m.ts); } catch (err) { hatch.log(`handler for ${m.source} failed: ${err.message}`); } }
    }
  });
  // Keyboard events do not bubble out of an iframe, so forward Hatch's reserved keys: Ctrl+Shift+G and P, Ctrl+` and Ctrl+B, the leader chord
  // (sent in init) and, while the host says the leader is armed, every key after it. The host decides what they mean.
  let leader = null; let armed = false;
  const fields = (e) => ({ type: 'hatch-shortcut', code: e.code, key: e.key, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey });
  const isLeader = (e) => !!leader && e.code === leader.code && !!e.ctrlKey === leader.ctrl && !!e.altKey === leader.alt && !!e.shiftKey === leader.shift && !!e.metaKey === leader.meta;
  // Ctrl+B in a text field of a widget stays with the field.
  const editable = (t) => !!t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(String(t.tagName).toUpperCase()) || !!t.isContentEditable);
  addEventListener('keydown', (e) => {
    const fold = (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyG') || (e.code === 'KeyP' && e.ctrlKey && !e.altKey && !e.metaKey)
      || (e.code === 'Backquote' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) || (e.code === 'KeyB' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && !editable(e.target));
    if (!fold && !armed && !isLeader(e)) return;
    e.preventDefault(); e.stopPropagation();
    if (!fold && !armed) armed = true; // optimistic; the host answers with the real state
    post(fields(e));
  }, true);
  addEventListener('blur', () => { armed = false; });
  addEventListener('focus', () => post({ type: 'hatch-focus' }));
  addEventListener('pointerdown', () => post({ type: 'hatch-focus' }), true);
  addEventListener('error', (e) => hatch.log(`error: ${e.message}`));
  window.hatch = hatch;
  post({ type: 'hatch-hello' }); // asks for init again in case the host sent it before this script listened
})();
