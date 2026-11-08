// terminal window: another terminal on its own tmux session (hatch-NAME), shown in a floating window.
// Closing the window leaves the tmux session running; opening it again re-attaches.
import { el, isViewOnly } from '../util.js';
import { initTerminal } from '../terminal.js';

export default {
  create(panel, ctx) {
    const host = el('div', { class: 'wterm' });
    const note = el('div', { class: 'banner', hidden: true });
    const root = el('div', { style: 'display:flex;flex-direction:column;height:100%;background:var(--term)' }, note, host);
    let t = null; let gone = false; let wantFocus = false; // focus asked for before xterm existed
    // xterm needs a laid-out element, so it starts once the window is in the document
    const boot = () => {
      if (gone) return;
      if (!host.isConnected || !host.clientWidth) return requestAnimationFrame(boot);
      t = initTerminal({
        host, api: ctx.api, toast: ctx.toast, onOpenFile: ctx.openFile, base: `/api/pterm/${panel.props.name}`, initialCmd: panel.props.cmd || null,
        onEnded: panel.props.cmd && !isViewOnly() ? () => { gone = true; ctx.api('DELETE', `/api/pterm/${panel.props.name}`).catch(() => {}); ctx.api('DELETE', `/api/panels/${panel.id}`).catch(() => {}); } : null,
        onStatus: (s) => { note.hidden = s === 'connected'; note.textContent = s === 'connected' ? '' : s === 'queued' ? `terminal ${panel.props.name}: waiting for a free connection (too many live windows; close one)` : `terminal ${panel.props.name}: ${s}`; },
        reconnectUi: () => {}, shortcuts: (e) => e.ctrlKey && e.shiftKey && (e.code === 'KeyG' || e.code === 'KeyP'),
      });
      t.connect();
      if (wantFocus) t.focus();
    };
    requestAnimationFrame(boot);
    root.addEventListener('pointerdown', () => t?.focus());
    return { el: root, focus() { wantFocus = true; t?.focus(); }, update() {}, destroy() { gone = true; t?.close(); } };
  },
};
