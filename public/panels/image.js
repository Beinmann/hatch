// An image is a usable terminal artifact: fit, inspect at actual size, zoom without clipping, and reuse its path.
import { el, isViewOnly } from '../util.js';
import { copyText } from '../terminal.js';
import { createAnnotator } from './annotate.js';

const urlFor = (src) => (src.startsWith('/') ? `/api/file?path=${encodeURIComponent(src)}` : `/files/uploads/${encodeURIComponent(src)}`);

export default {
  create(panel, ctx) {
    const sourcePath = () => panel.props.src.startsWith('/') || !ctx.uploadsDir?.() ? panel.props.src : `${ctx.uploadsDir()}/${panel.props.src}`;
    const img = el('img', { alt: panel.title, draggable: 'false', title: 'Click (when focused): fit / actual size · wheel or +/−: zoom · 0: fit · 1: actual size' });
    const name = el('span', { class: 'image-name' });
    const dimensions = el('span', { class: 'image-dimensions muted' });
    const zoom = el('button', { type: 'button', title: 'Toggle fit / actual size', disabled: true, onclick: () => setZoom(mode === 'fit' ? 1 : 'fit') }, 'Fit');
    const canvas = el('div', { class: 'image-canvas' }, img);
    const stage = el('div', { class: 'stage image-viewport' }, canvas);
    const error = el('div', { class: 'image-error muted', hidden: true, role: 'status' });
    let scale = 1; let mode = 'fit'; let annotation = null;
    const action = (label, fn) => el('button', { type: 'button', disabled: isViewOnly() && label === 'Annotate', onclick: () => { menu.open = false; fn(); } }, label);
    const menu = el('details', { class: 'image-actions' }, el('summary', { title: 'Image actions' }, 'Actions'), el('div', { class: 'image-menu' },
      action('Annotate', () => startAnnotate()),
      action('Copy path', async () => ctx.toast(await copyText(sourcePath()) ? 'Path copied' : 'Copy failed', 'info')),
      action('Fit to window', () => setZoom('fit')),
      action('Actual size', () => setZoom(1))));
    const root = el('div', { class: 'imgview', tabindex: '-1' }, stage, error,
      el('div', { class: 'cap image-cap' }, name, dimensions, zoom,
        el('button', { type: 'button', title: 'Paste this image path into the terminal', hidden: isViewOnly(), onclick: () => { ctx.typePath(sourcePath()); ctx.term.focus(); } }, 'Use path'), menu));

    function setZoom(value, pointer) {
      if (!img.naturalWidth || !stage.clientWidth || annotation) return;
      const oldWidth = img.naturalWidth * scale; const oldHeight = img.naturalHeight * scale;
      const x = pointer?.x ?? stage.clientWidth / 2; const y = pointer?.y ?? stage.clientHeight / 2;
      const oldLeft = Math.max(0, (canvas.clientWidth - oldWidth) / 2); const oldTop = Math.max(0, (canvas.clientHeight - oldHeight) / 2);
      const sourceX = (stage.scrollLeft + x - oldLeft) / scale; const sourceY = (stage.scrollTop + y - oldTop) / scale;
      mode = value === 'fit' ? 'fit' : 'zoom';
      scale = mode === 'fit' ? Math.min(1, stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight) : Math.max(0.05, Math.min(16, Number(value)));
      const width = img.naturalWidth * scale; const height = img.naturalHeight * scale;
      canvas.style.width = `${Math.max(stage.clientWidth, width)}px`; canvas.style.height = `${Math.max(stage.clientHeight, height)}px`;
      img.style.width = `${width}px`; img.style.height = `${height}px`;
      stage.scrollLeft = mode === 'fit' ? 0 : Math.max(0, (canvas.clientWidth - width) / 2 + sourceX * scale - x);
      stage.scrollTop = mode === 'fit' ? 0 : Math.max(0, (canvas.clientHeight - height) / 2 + sourceY * scale - y);
      zoom.textContent = `${Math.round(scale * 100)}%`; zoom.title = `${mode === 'fit' ? 'Fitted' : 'Zoomed'} · click for ${mode === 'fit' ? 'actual size' : 'fit'}`;
    }
    img.addEventListener('load', () => { zoom.disabled = false; error.hidden = true; dimensions.textContent = `${img.naturalWidth} × ${img.naturalHeight}`; setZoom('fit'); });
    img.addEventListener('error', () => { zoom.disabled = true; dimensions.textContent = ''; error.hidden = false; error.textContent = `Could not display ${panel.props.src}. Check that the file exists and uses a supported image format.`; });
    // the first click on an unfocused window only focuses it; a click on an already focused window toggles fit / actual size
    img.addEventListener('click', () => { if (root.closest('.win')?.dataset.hadFocus === '') return; setZoom(mode === 'fit' ? 1 : 'fit'); });
    stage.addEventListener('wheel', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); setZoom(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), { x: e.clientX - r.left, y: e.clientY - r.top }); }, { passive: false });
    root.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || annotation || e.target.closest('button,summary')) return;
      if (['+', '=', '-', '0', '1'].includes(e.key)) { e.preventDefault(); setZoom(e.key === '0' ? 'fit' : e.key === '1' ? 1 : scale * (e.key === '-' ? 1 / 1.15 : 1.15)); }
    });
    const observer = new ResizeObserver(() => setZoom(mode === 'fit' ? 'fit' : scale)); observer.observe(stage);
    const normal = [...root.children];
    function restore() { annotation = null; root.replaceChildren(...normal); setZoom(mode === 'fit' ? 'fit' : scale); }
    function startAnnotate() {
      if (isViewOnly()) return;
      if (!img.naturalWidth) return ctx.toast('The image has not loaded', 'warn');
      annotation = createAnnotator({ img, onCancel: restore, onError: (e) => ctx.toast(`Could not save annotation: ${e.message}`, 'bad'), onSave: async (blob) => {
        if (!blob) return ctx.toast('Could not encode the annotated image', 'bad');
        const saved = await ctx.uploadImage(blob, `annotated-${panel.title}`); if (saved) restore();
      } });
      root.replaceChildren(...annotation.el.children);
    }
    const show = (p) => {
      const changed = p.props.src !== panel.props.src; panel = p;
      name.textContent = p.props.src.split('/').pop(); name.title = sourcePath(); img.alt = p.title;
      if (changed || !img.getAttribute('src')) { if (annotation) restore(); zoom.disabled = true; dimensions.textContent = ''; error.hidden = true; canvas.style.width = canvas.style.height = ''; img.style.width = img.style.height = ''; let source = p.props.src;
        if (isViewOnly() && source.startsWith('/')) {
          const prefix = `${ctx.uploadsDir?.() || ''}/`;
          const name = source.startsWith(prefix) ? source.slice(prefix.length) : null;
          if (!name || name.includes('/')) { error.hidden = false; error.textContent = 'Images outside uploads are unavailable in view-only mode.'; return; }
          source = name;
        }
        img.src = urlFor(source); }
    };
    show(panel);
    return { el: root, update: show, focus() { root.focus({ preventScroll: true }); }, isDirty: () => !!annotation?.count(), beforeClose: () => !annotation?.count() || window.confirm('Discard unsaved image annotations?'), destroy() { observer.disconnect(); } };
  },
};
