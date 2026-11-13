// files panel (Emacs dired / VS Code explorer, small): browse the box, open images and text files, download, drop files to upload.
import { el, isViewOnly } from '../util.js';
import { copyText } from '../terminal.js';

import { IMG, PREVIEW_DELAY, previewTarget, previewUrl } from './files-preview.js';

const human = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const icon = (e) => (e.type === 'dir' ? '📁' : e.type === 'broken' ? '⚠️' : IMG.test(e.name) ? '🖼️' : '📄');
const join = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

export default {
  create(panel, ctx) {
    if (isViewOnly()) return { el: el('div', { class: 'muted pad' }, 'File browsing is unavailable in view-only mode.'), update() {}, destroy() {} };
    const crumbs = el('div', { class: 'crumbs' });
    const tools = el('div', { class: 'crumbs', style: 'border-bottom:1px solid var(--line);gap:6px' });
    const act = async (route, body, okMsg, folder) => {
      try {
        await ctx.api('POST', `/api/fs/${route}`, body);
        if (destroyed) return;
        if (okMsg) ctx.toast(okMsg);
        if (!loading && dir === folder) load(folder);
      } catch (e) { if (!destroyed) ctx.toast(e.message, 'bad', 7000); }
    };
    const list = el('ul', { class: 'flist' });
    const msg = el('div', { class: 'muted small pad', hidden: true });
    const previewImg = el('img', { alt: '', draggable: 'false' });
    const preview = el('div', { class: 'fpreview', hidden: true }, previewImg, el('div', { class: 'fpreview-name muted small' }));
    const root = el('div', { class: 'files', tabindex: '0', style: 'display:flex;flex-direction:column;height:100%;outline:none' }, crumbs, tools, el('div', { class: 'fbody' }, el('div', { class: 'flistwrap' }, msg, list), preview));
    let entries = []; let previewTimer = null; let shown = '';
    let sel = ''; // name of the keyboard-selected row ('..' for the parent row); kept across the 5 s refresh
    let parentDir = null; let rows = [];
    let dir = panel.props.path || ''; let requested = dir; let revision = 0; let loading = false; let destroyed = false;

    async function load(p) {
      if (destroyed) return;
      const request = ++revision; requested = p || '/'; loading = true;
      root.setAttribute('aria-busy', 'true'); msg.hidden = false; msg.textContent = `Loading ${requested}…`;
      try {
        const d = await ctx.api('GET', `/api/fs/list?path=${encodeURIComponent(p || '/')}`);
        if (destroyed || request !== revision) return;
        dir = requested = d.path; msg.hidden = true;
        tools.replaceChildren(
          el('button', { type: 'button', title: 'Create an empty file here', onclick: () => { const n = (window.prompt('New file name') || '').trim(); if (n && !n.includes('/')) act('newfile', { path: join(d.path, n) }, `Created ${n}`, d.path); } }, '+ file'),
          el('button', { type: 'button', title: 'Create a folder here', onclick: () => { const n = (window.prompt('New folder name') || '').trim(); if (n && !n.includes('/')) act('mkdir', { path: join(d.path, n) }, `Created ${n}/`, d.path); } }, '+ folder'));
        const parts = d.path.split('/').filter(Boolean);
        crumbs.replaceChildren(el('button', { type: 'button', onclick: () => go('/') }, '/'),
          ...parts.map((seg, i) => el('button', { type: 'button', onclick: () => go(`/${parts.slice(0, i + 1).join('/')}`) }, seg)));
        parentDir = d.parent; entries = d.entries;
        list.replaceChildren(...(d.parent ? [el('li', { class: 'dir', 'data-name': '..', onclick: () => go(d.parent) }, el('span', { class: 'ico' }, '↰'), el('span', {}, '..'))] : []),
          ...d.entries.map((e) => {
            const full = join(d.path, e.name);
            const ren = el('button', { type: 'button', title: 'Rename or move (a new name or a full path)', onclick: (ev) => { ev.stopPropagation(); const n = (window.prompt('New name (or absolute path)', e.name) || '').trim(); if (n && n !== e.name) act('rename', { from: full, to: n.startsWith('/') ? n : join(d.path, n) }, 'Renamed', d.path); } }, '✎');
            const del = el('button', { type: 'button', title: 'Delete (click twice)', onclick: (ev) => { ev.stopPropagation(); if (del.dataset.armed) act('delete', { path: full, recursive: e.type === 'dir' }, 'Deleted', d.path); else { del.dataset.armed = '1'; del.textContent = 'Sure?'; setTimeout(() => { delete del.dataset.armed; del.textContent = '🗑'; }, 3000); } } }, '🗑');
            const actions = [ren, del, ...(e.type === 'file' ? [
              el('a', { href: `/api/fs/download?path=${encodeURIComponent(full)}`, title: 'Download', onclick: (ev) => ev.stopPropagation() }, '↓'),
              el('button', { type: 'button', title: 'Type the path into the terminal', onclick: (ev) => { ev.stopPropagation(); ctx.typePath ? ctx.typePath(full) : ctx.term?.sendText(`${full} `); } }, '⌨'),
              el('button', { type: 'button', title: 'Copy path', onclick: async (ev) => { ev.stopPropagation(); ctx.toast(await copyText(full) ? 'Path copied' : 'Copy failed'); } }, '⧉')] : [])];
            return el('li', { class: e.type, title: full, draggable: e.type === 'file' ? 'true' : null, ondragstart: (ev) => { ev.dataTransfer.setData('application/x-hatch-path', full); ev.dataTransfer.setData('text/plain', full); }, 'data-name': e.name, onclick: () => { sel = e.type === 'dir' ? '' : e.name; open(e, full); } }, el('span', { class: 'ico' }, icon(e)), el('span', {}, e.type === 'dir' ? `${e.name}/` : e.name), el('span', { class: 'muted small' }, e.type === 'file' ? human(e.size) : ''), ...actions);
          }));
        rows = [...list.children]; paintSel(false);
      } catch (e) {
        if (!destroyed && request === revision) { msg.hidden = false; msg.textContent = e.message; }
      } finally {
        if (!destroyed && request === revision) { loading = false; root.setAttribute('aria-busy', 'false'); }
      }
    }
    function paintSel(scroll = true) {
      rows.forEach((r) => r.classList.toggle('sel', r.dataset.name === sel));
      if (scroll) rows.find((r) => r.dataset.name === sel)?.scrollIntoView({ block: 'nearest' });
      schedulePreview();
    }
    // Image preview follows the selection; debounced so holding j/k does not fetch every image on the way.
    function schedulePreview() {
      clearTimeout(previewTimer);
      const target = previewTarget(dir, entries, sel);
      if (target === (shown || null)) return;
      if (!target) { shown = ''; preview.hidden = true; previewImg.removeAttribute('src'); return; }
      previewTimer = setTimeout(() => {
        if (destroyed) return;
        shown = target; preview.hidden = false;
        previewImg.src = previewUrl(target); previewImg.alt = sel;
        preview.lastChild.textContent = sel;
      }, PREVIEW_DELAY);
    }
    const move = (n) => { if (!rows.length) return; const i = rows.findIndex((r) => r.dataset.name === sel); sel = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? (n > 0 ? 0 : rows.length - 1) : i + n))].dataset.name; paintSel(); };
    // vim keys: j/k move, h = parent folder, l = enter a folder or open a file. Ignored while typing and with modifiers.
    root.addEventListener('keydown', (ev) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.target.closest?.('input,textarea,select,[contenteditable]') || loading) return;
      const k = ev.key;
      if (k === 'j' || k === 'ArrowDown') move(1);
      else if (k === 'k' || k === 'ArrowUp') move(-1);
      else if ((k === 'h' || k === 'ArrowLeft') && parentDir) { sel = dir.split('/').pop(); go(parentDir, true); } // the folder we came from stays selected
      else if (k === 'l' || k === 'ArrowRight' || k === 'Enter') {
        if (sel === '..') go(parentDir);
        else { const e = rows.find((r) => r.dataset.name === sel); if (e) e.click(); else move(1); }
      } else return;
      ev.preventDefault(); ev.stopPropagation();
    });
    const go = (p, keepSel = false) => { if (!keepSel) sel = ''; load(p); ctx.patch(panel.id, { props: { path: p } }).catch(() => {}); };
    function open(e, full) {
      if (e.type === 'dir') return go(full);
      if (e.type !== 'file') return;
      const body = IMG.test(e.name) ? { type: 'image', title: e.name, props: { src: full } }
        : { type: 'editor', title: e.name, props: { path: full }, w: 560, h: 380 };
      ctx.api('POST', '/api/panels', body).catch((er) => { if (!destroyed) ctx.toast(er.message, 'bad'); });
    }

    // drop files here to upload them into the folder that is shown
    root.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.stopPropagation(); } });
    root.addEventListener('drop', async (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault(); e.stopPropagation();
      if (destroyed) return;
      if (loading || !dir) { ctx.toast('Wait for the folder to finish loading before uploading', 'bad'); return; }
      const destination = dir; const files = [...e.dataTransfer.files];
      for (const f of files) {
        try {
          const r = await fetch(`/api/fs/upload?dir=${encodeURIComponent(destination)}&name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
          const d = await r.json(); if (!r.ok) throw new Error(d.error);
          if (!destroyed) ctx.toast(`Uploaded ${f.name} to ${destination}`);
        } catch (er) { if (!destroyed) ctx.toast(`Upload failed: ${er.message}`, 'bad'); }
      }
      if (!destroyed && !loading && dir === destination) load(destination);
    });

    const timer = setInterval(() => { if (!destroyed && !loading && dir && root.offsetParent) load(dir); }, 5000); // pick up changes made in the terminal
    load(dir || ctx.cwd());
    return { el: root, focus() { root.focus({ preventScroll: true }); }, update(p) { if (p.props.path && p.props.path !== requested) load(p.props.path); }, destroy() { destroyed = true; clearTimeout(previewTimer); revision++; clearInterval(timer); } };
  },
};
