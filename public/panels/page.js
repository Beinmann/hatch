// page panel: an HTML file from the box rendered in a sandboxed iframe (`hatch open FILE.html`). Scripts run, but the frame has
// an opaque origin (no allow-same-origin): it cannot read our cookie or call the API. The server serves the file and its
// siblings under /page/KEY/ (see src/pages.js); the key lives in the panel file.
import { el } from '../util.js';

export default {
  create(panel, ctx) {
    const frame = el('iframe', { title: panel.title, sandbox: 'allow-scripts allow-forms allow-popups', referrerpolicy: 'no-referrer' });
    let current = panel;
    const src = (p) => (/^[a-f0-9]{32}$/.test(String(p.props.key)) ? `/page/${p.props.key}/${encodeURIComponent(String(p.props.path).split('/').pop())}` : null);
    const reload = () => { const u = src(current); frame.src = u || 'about:blank'; };
    const edit = () => ctx.api('POST', '/api/panels', { type: 'editor', title: String(current.props.path).split('/').pop(), props: { path: current.props.path } }).catch((e) => ctx.toast(e.message, 'bad'));
    const bar = el('div', { class: 'banner' }, el('span', { class: 'muted small', title: 'Runs in a sandbox: scripts yes, Hatch no' }, 'sandboxed page'),
      el('button', { type: 'button', onclick: reload }, 'Reload'), el('button', { type: 'button', title: 'Open the HTML source in an editor window', onclick: edit }, 'Edit source'));
    const note = el('div', { class: 'banner', hidden: true }, 'This page window has no key (hand-written panel file?). Close it and open the file again with: hatch open FILE.html');
    const root = el('div', { style: 'display:flex;flex-direction:column;height:100%' }, note, bar, el('div', { style: 'flex:1;min-height:0' }, frame));
    const show = (p) => { const prev = src(current); current = p; note.hidden = !!src(p); if (src(p) !== prev || !frame.src || frame.src === 'about:blank') reload(); };
    note.hidden = !!src(panel); reload();
    return { el: root, update: show, destroy() { frame.src = 'about:blank'; } };
  },
};
