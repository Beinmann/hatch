// The terminal: xterm.js on the tmux pty. Output arrives over SSE (base64), input and size go back by POST.
// Reload re-attaches to the stream (the server replays its buffer); a dropped pty reconnects with backoff.
import { Terminal } from './xterm.mjs';
import { isViewOnly } from './util.js';
import { FitAddon } from './addon-fit.mjs';
import { streamSlots } from './stream-slots.js';

const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// Async clipboard (secure contexts only), else the textarea trick: plain http on a LAN is not a secure context.
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
  document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* not allowed */ }
  ta.remove();
  return ok;
}

// background/foreground, plus a 16-colour palette when the theme (custom.css) defines --ansi-0 .. --ansi-15
const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
function themeFromCss() {
  const css = getComputedStyle(document.documentElement);
  const t = { background: css.getPropertyValue('--term').trim() || '#0a1010', foreground: css.getPropertyValue('--termfg').trim() || '#d8e6e3' };
  if (document.documentElement.classList.contains('has-bg') || document.documentElement.classList.contains('has-tr')) t.background = '#00000000'; // the terminal pane tints itself in CSS so the page background shows through
  ANSI_NAMES.forEach((n, i) => { const v = css.getPropertyValue(`--ansi-${i}`).trim(); if (v) t[n] = v; });
  return t;
}

export function initTerminal({ host, api, toast, onCopy = () => {}, onBell = () => {}, onOpenFile = () => {}, onClipboard = () => {}, onStatus, reconnectUi, shortcuts = () => false, fontSize = 14, onFontSize = () => {}, base = '/api/term', initialCmd = null, onEnded = null }) {
  const css = getComputedStyle(document.documentElement);
  const term = new Terminal({
    allowTransparency: true,
    cursorBlink: true, fontSize, scrollback: 5000, fontFamily: css.getPropertyValue('--mono') || 'monospace',
    theme: themeFromCss(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();
  term.onBell(() => onBell());
  // Clickable file references and URLs in the output (IDE style): `src/app.js:12`, `/abs/path.py:3:9`, https://...
  // A reference opens through onOpenFile(path, line); URLs open in a new tab.
  const FILEREF = /(?:^|[\s("'`])((?:\/|\.{1,2}\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z]{1,6}):(\d+)(?::\d+)?/g;
  const URLRE = /https?:\/\/[^\s<>"'`)\]]+/g;
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)?.translateToString(true) || '';
      const links = [];
      for (const m of line.matchAll(URLRE)) links.push({ range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].length, y } }, text: m[0], activate: (_e, t) => window.open(t, '_blank', 'noopener') });
      for (const m of isViewOnly() ? [] : line.matchAll(FILEREF)) {
        const full = m[0].slice(m[0].indexOf(m[1])); const at = m.index + m[0].indexOf(m[1]);
        links.push({ range: { start: { x: at + 1, y }, end: { x: at + full.length, y } }, text: full, activate: () => onOpenFile(m[1], Number(m[2])) });
      }
      callback(links.length ? links : undefined);
    },
  });
  // OSC 52 (tmux set-clipboard, vim/neovim yank over ssh): the program asks the terminal to set the clipboard.
  term.parser.registerOscHandler(52, (data) => {
    const i = data.indexOf(';'); const payload = i >= 0 ? data.slice(i + 1) : '';
    if (payload && payload !== '?') { try { onClipboard(new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)))); } catch { /* not valid base64 */ } }
    return true;
  });

  let source = null; let lease = null; let retry = 0; let retryTimer = null; let opened = false;
  let closed = false; let revision = 0; let inputEpoch = 0;
  let controller = new AbortController();
  let queue = Promise.resolve(); // keystrokes must arrive in order
  let replaying = false; // xterm answers terminal queries found in old output; those answers must not reach the shell

  let viewer = false;
  const readOnly = () => viewer || isViewOnly();
  const send = (data) => {
    if (closed || !opened || readOnly()) return;
    const epoch = inputEpoch; const signal = controller.signal;
    queue = queue.then(() => { if (!closed && opened && !readOnly() && epoch === inputEpoch) return api('POST', `${base}/input`, { data }, { signal }); }).catch(() => {});
  };
  // Sticky Ctrl for touch keyboards: the next typed letter is sent as its control code (Ctrl+C = 0x03).
  let ctrl = false; let onCtrl = () => {};
  term.onData((d) => {
    if (closed || !opened || replaying || readOnly()) return;
    // xterm also reports focus changes, mouse clicks and answers to terminal queries through onData; those are not keystrokes
    if (ctrl && d.length === 1) { const c = d.toUpperCase().charCodeAt(0); if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64); ctrl = false; onCtrl(false); }
    send(d);
  });

  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && shortcuts(e)) return false;
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); return true; } // Tab belongs to the shell
    // Ctrl+C with a selection copies it; without one it stays the interrupt.
    if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c' && term.hasSelection()) {
      onCopy(term.getSelection());
      copyText(term.getSelection()).then((ok) => { if (!ok) toast('Copy failed: the browser denied clipboard access', 'bad'); });
      e.preventDefault();
      return false;
    }
    // Ctrl+V / Ctrl+Shift+V: leave it to the browser's paste event. xterm would also send a raw ^V to the program, and Claude Code
    // answers that by reading the BOX's clipboard ("no image in clipboard"). Pasted images are handled by the page (app.js).
    if (e.type === 'keydown' && e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'v') return false;
    return true;
  });

  let resizeTimer = null;
  const pushSize = () => {
    if (closed) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (closed) return; try { fit.fit(); } catch { return; } if (!opened || readOnly()) return; api('POST', `${base}/resize`, { cols: term.cols, rows: term.rows }, { signal: controller.signal }).catch(() => {}); }, 80);
  };
  const observer = new ResizeObserver(pushSize); observer.observe(host);

  function drop() { source?.close(); source = null; lease?.release(); lease = null; }
  async function connect() {
    if (closed) return;
    controller.abort(); controller = new AbortController(); queue = Promise.resolve();
    const signal = controller.signal;
    const attempt = ++revision; inputEpoch++; opened = false; replaying = false;
    clearTimeout(retryTimer); clearTimeout(resizeTimer);
    drop();
    onStatus('connecting');
    try {
      if (base === '/api/term') {
        const info = await api('GET', base, undefined, { signal });
        if (closed || attempt !== revision) return;
        viewer = !!info.viewOnly;
      } else if (!readOnly()) await api('POST', base, { cmd: initialCmd }, { signal });
    } catch (e) {
      if (closed || attempt !== revision) return;
      onStatus('offline', e.message);
      reconnectUi(`The terminal cannot start: ${e.message}`);
      return schedule();
    }
    if (closed || attempt !== revision) return;
    // window terminals share a few stream slots (see stream-slots.js); the main terminal is part of the budget
    if (base === '/api/term') return stream(attempt);
    onStatus('queued'); lease = streamSlots.acquire(() => { if (!closed && attempt === revision) stream(attempt); else drop(); });
  }
  function stream(attempt) {
    const connection = new EventSource(`${base}/stream`); source = connection;
    const current = () => !closed && attempt === revision && source === connection;
    let replayEpoch = 0;
    connection.onopen = () => {
      if (!current()) return;
      inputEpoch++; queue = Promise.resolve(); opened = false; const opening = ++replayEpoch;
      // Drain accepted old writes before resetting; the new stream's replay is queued after this marker.
      term.write('', () => {
        if (!current() || opening !== replayEpoch) return;
        term.reset(); opened = true; retry = 0; reconnectUi(null); onStatus('connected'); pushSize();
      });
    };
    connection.addEventListener('replay', (m) => {
      if (!current()) return;
      const epoch = replayEpoch; replaying = true;
      term.write(decode(m.data), () => { if (current() && epoch === replayEpoch) replaying = false; });
    });
    connection.onmessage = (m) => { if (current()) term.write(decode(m.data)); };
    connection.addEventListener('exit', () => {
      if (!current()) return;
      opened = false; inputEpoch++; drop();
      // a window whose program ended (vim after :q) closes instead of reconnecting, which would start the program again
      if (onEnded) { api('GET', `${base}/alive`).then((r) => { if (r.alive === false) onEnded(); else { onStatus('detached'); schedule(); } }, () => schedule()); return; }
      onStatus('detached'); reconnectUi('Session detached (tmux is still running).'); schedule();
    });
    connection.onerror = () => {
      if (!current()) return;
      opened = false; inputEpoch++;
      if (connection.readyState === EventSource.CLOSED) { drop(); onStatus('offline'); schedule(); }
      else onStatus('connecting');
    };
  }
  function schedule() {
    if (closed) return;
    const attempt = revision;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (!closed && attempt === revision) connect(); }, Math.min(15000, 1000 * 2 ** retry++));
  }

  // Find in scrollback (Emacs isearch idea): selects the next match and scrolls to it. Case-insensitive, wraps around.
  let at = { row: -1, col: -1 };
  function find(query, dir = 1) {
    if (!query) return { found: false, total: 0 };
    const buf = term.buffer.active; const q = query.toLowerCase(); const n = buf.length;
    const lines = []; for (let i = 0; i < n; i++) lines.push((buf.getLine(i)?.translateToString(true) || '').toLowerCase());
    const hits = []; // every match, in reading order
    lines.forEach((l, row) => { for (let col = l.indexOf(q); col >= 0; col = l.indexOf(q, col + 1)) hits.push({ row, col }); });
    if (!hits.length) { term.clearSelection(); return { found: false, total: 0 }; }
    let i = dir > 0 ? hits.findIndex((h) => h.row > at.row || (h.row === at.row && h.col > at.col)) : hits.findLastIndex((h) => h.row < at.row || (h.row === at.row && h.col < at.col));
    if (i < 0) i = dir > 0 ? 0 : hits.length - 1; // wrap
    at = hits[i];
    term.select(at.col, at.row, query.length);
    term.scrollToLine(Math.max(0, at.row - Math.floor(term.rows / 2)));
    return { found: true, index: i + 1, total: hits.length };
  }
  const resetFind = () => { at = { row: -1, col: -1 }; term.clearSelection(); };

  return {
    // Ends the stream, the reconnect timer and the resize observer (a closed terminal window must not keep a connection).
    close() { if (closed) return; closed = true; opened = false; revision++; inputEpoch++; controller.abort(); queue = Promise.resolve(); clearTimeout(retryTimer); clearTimeout(resizeTimer); drop(); observer.disconnect(); term.dispose(); },
    // Drops the stream without closing the terminal (a workspace that is not shown holds no connection: browsers allow only a few
    // per origin). The program keeps running in tmux; connect() later re-attaches and the server replays recent output.
    pause() { if (closed) return; opened = false; revision++; inputEpoch++; controller.abort(); queue = Promise.resolve(); clearTimeout(retryTimer); clearTimeout(resizeTimer); drop(); retry = 0; },
    retheme() { if (closed) return; term.options.theme = themeFromCss(); }, // after custom.css has loaded
    find, resetFind,
    sendKey: (seq) => { if (closed) return; send(seq); term.focus(); },
    toggleCtrl() { ctrl = !ctrl; onCtrl(ctrl); term.focus(); return ctrl; },
    onCtrl: (fn) => { onCtrl = fn; },
    connect, focus: () => { if (!closed) term.focus(); },
    // term.paste wraps the text in bracketed-paste markers only when the program in the terminal asked for them
    // (Claude Code does; a plain bash may not and would echo the markers as garbage).
    sendText: (text) => { if (!closed && opened && !readOnly()) term.paste(text); },
    type: (text) => send(text), // raw keystrokes (saved commands: text plus Enter)
    fit: pushSize, term,
    setFontSize(delta) { if (closed) return; term.options.fontSize = Math.max(8, Math.min(32, (term.options.fontSize || 14) + delta)); onFontSize(term.options.fontSize); pushSize(); },
    isOpen: () => opened,
  };
}
