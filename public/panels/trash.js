// trash window: recently closed windows, newest first, with a restore button each.
// It refetches /api/trash on every panel event (a close or restore anywhere moves a file in or out of trash/).
import { el, isViewOnly } from '../util.js';

export default {
  create(panel, ctx) {
    const list = el('ul', { class: 'flist', style: 'flex:1;overflow:auto' });
    const err = el('div', { class: 'banner', hidden: true });
    const emptyBtn = el('button', { type: 'button', title: 'Delete every closed window for good' }, 'Empty trash');
    const root = el('div', { style: 'display:flex;flex-direction:column;height:100%' }, err, list,
      el('div', { class: 'cap', style: 'display:flex;justify-content:flex-end;padding:6px 8px;border-top:1px solid var(--line)' }, emptyBtn));
    let destroyed = false; let request = 0;

    const paint = (entries) => {
      emptyBtn.disabled = isViewOnly() || !entries.length;
      list.replaceChildren(...(entries.length ? entries.map((e) => el('li', { title: `${e.type} · ${e.id}` },
        el('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis' }, e.title),
        el('span', { class: 'muted small' }, `${e.type} · ${e.closed ? new Date(e.closed).toLocaleString() : '?'}`),
        el('button', { type: 'button', disabled: isViewOnly(), onclick: () => act(() => ctx.api('POST', '/api/trash/restore', { trashId: e.trashId })) }, 'Restore'))) : [el('li', { class: 'muted' }, 'Trash is empty')]));
    };
    async function refresh() {
      const mine = ++request;
      try {
        const entries = await ctx.api('GET', '/api/trash');
        if (destroyed || mine !== request) return;
        err.hidden = true; paint(entries);
      } catch (e) { if (!destroyed && mine === request) { err.hidden = false; err.textContent = e.message; } }
    }
    async function act(fn) {
      try { await fn(); } catch (e) { if (!destroyed) ctx.toast(e.message, 'bad'); }
      refresh();
    }
    emptyBtn.addEventListener('click', () => act(() => ctx.api('DELETE', '/api/trash')));
    const off = ctx.onPanelEvent(() => refresh());
    refresh();
    return { el: root, update() {}, destroy() { destroyed = true; off(); } };
  },
};
