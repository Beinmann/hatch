// widget panel: a sandboxed iframe (allow-scripts only, so an opaque origin: it cannot read our cookie or call the
// API). Data comes through postMessage from here; sources run on the server and arrive over SSE.
import { el } from '../util.js';
import { createLastValues } from '../last-values.js';

export default {
  create(panel, ctx) {
    const name = panel.props.name;
    const frame = el('iframe', { title: panel.title, sandbox: 'allow-scripts' });
    const status = el('div', { class: 'banner', hidden: true });
    const root = el('div', { style: 'display:flex;flex-direction:column;height:100%' }, status, el('div', { style: 'flex:1;min-height:0' }, frame));
    const lastValues = createLastValues(); // replayed when the iframe reloads (dock/float move) under a live subscription
    const streams = new Map(); // source name -> unsubscribe function
    const post = (m) => frame.contentWindow?.postMessage(m, '*');
    const declared = () => (ctx.widgetInfo(name)?.meta?.sources || []).map((s) => s.name);

    const closeAll = () => { for (const off of streams.values()) off(); streams.clear(); lastValues.clear(); };
    const subscribe = (source) => {
      if (streams.has(source)) { lastValues.replay(source, (value, ts) => post({ type: 'data', source, value, ts })); return; }
      if (!declared().includes(source)) { status.hidden = false; status.textContent = `widget asked for source "${source}" which widget.json does not declare`; return; }
      streams.set(source, ctx.subscribeSource(name, source, (value, ts) => { lastValues.set(source, value, ts); post({ type: 'data', source, value, ts }); }));
    };
    // hatch.call: one run of an exec source with an argument; the answer goes back under the widget's own request id
    const call = (m) => {
      const reply = (r) => post({ type: 'result', id: m.id, ...r });
      if (!declared().includes(String(m.source))) return reply({ error: `widget.json does not declare source "${m.source}"` });
      ctx.callSource(name, String(m.source), m.arg === undefined ? undefined : String(m.arg)).then((value) => reply({ value }), (e) => reply({ error: e.message }));
    };
    const onMessage = (e) => {
      if (e.source !== frame.contentWindow) return;
      const m = e.data || {};
      if (m.type === 'hatch-focus' && document.activeElement === frame) ctx.focusPanel?.(panel.id, false);
      else if (m.type === 'hatch-shortcut') {
        // A keydown inside the frame proves it holds the keyboard, so no activeElement check: right after a widget opens the
        // host can still report another element while keys already land in the frame, which made the leader dead until a click.
        // the key may move focus away (leader t), so the panel is raised first and the SDK is told whether the leader is still armed
        ctx.focusPanel?.(panel.id, false); post({ type: 'hatch-leader', armed: !!ctx.shortcut?.(m) });
      }
      else if (m.type === 'hatch-hello') sendInit(); // the SDK may have started after the load event's init
      else if (m.type === 'subscribe') subscribe(String(m.source));
      else if (m.type === 'call') call(m);
      else if (m.type === 'unsubscribe') { streams.get(m.source)?.(); streams.delete(m.source); }
      else if (m.type === 'log') console.log(`[widget ${name}]`, m.text);
      else if (m.type === 'resize' && Number.isFinite(m.w) && Number.isFinite(m.h)) ctx.patch(panel.id, { w: Math.round(m.w), h: Math.round(m.h) }).catch(() => {});
    };
    addEventListener('message', onMessage);

    const sendInit = () => {
      const cs = getComputedStyle(document.documentElement);
      post({ type: 'init', leader: ctx.leaderChord?.() || null, name, sources: declared(), theme: { bg: cs.getPropertyValue('--surface').trim(), fg: cs.getPropertyValue('--fg').trim(), accent: cs.getPropertyValue('--accent').trim(), muted: cs.getPropertyValue('--muted').trim(), mono: cs.getPropertyValue('--mono').trim() } });
    };
    frame.addEventListener('load', () => {
      sendInit();
      // focus() ran before the page existed when the window opened; take the keyboard now unless the user moved on
      const a = document.activeElement;
      if (a === document.body || a === frame) { frame.focus(); post({ type: 'hatch-take-focus' }); }
    });
    const load = () => {
      closeAll();
      const info = ctx.widgetInfo(name);
      status.hidden = !!info;
      if (!info) status.textContent = `no widget "${name}" in the state dir (widgets/${name}/index.html)`;
      frame.src = `/widgets/${encodeURIComponent(name)}/index.html?rev=${info?.rev ?? 0}`;
    };
    load();
    return {
      el: root, focus() { frame.focus(); }, update() {}, destroy() { removeEventListener('message', onMessage); closeAll(); frame.src = 'about:blank'; },
      widgetChanged(info) { if (info.name === name) load(); },
    };
  },
};
