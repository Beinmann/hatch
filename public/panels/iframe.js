// iframe panel: for a live dev server. The URL is loaded by the BROWSER, so `localhost` means the user's own machine.
import { el } from '../util.js';

export default {
  create(panel, ctx) {
    const frame = el('iframe', { title: panel.title, referrerpolicy: 'no-referrer' });
    const banner = el('div', { class: 'banner', hidden: true });
    const root = el('div', { style: 'display:flex;flex-direction:column;height:100%' }, banner, el('div', { style: 'flex:1;min-height:0' }, frame));
    const show = (p) => {
      const url = p.props.url;
      let u = null; try { u = new URL(url, location.href); } catch { /* shown as is */ }
      const local = u && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && !['localhost', '127.0.0.1'].includes(location.hostname);
      banner.hidden = !local;
      if (local) {
        banner.replaceChildren(`"${u.hostname}" points at your own machine, not at this box. `,
          u.port ? el('button', { type: 'button', title: 'Hatch forwards to the box\'s own port', onclick: () => ctx.patch(p.id, { props: { url: `/proxy/${u.port}${u.pathname}${u.search}` } }) }, 'Use the Hatch proxy') : null,
          el('button', { type: 'button', onclick: () => { u.hostname = location.hostname; ctx.patch(p.id, { props: { url: u.href } }); } }, `Use ${location.hostname}`));
      }
      frame.src = url;
    };
    show(panel);
    return { el: root, update: show, destroy() { frame.src = 'about:blank'; } };
  },
};
