// Screenshot renderer for widget pages: turns the page it runs in into a PNG, with no library and no headless browser.
// The DOM is cloned, serialized as XHTML and drawn through an SVG <foreignObject> onto a canvas (the browser does the layout
// and painting). Loaded on demand by sdk.js inside the widget iframe, so it also sees the widget's own DOM, which the Hatch
// page cannot reach across the sandbox. Limits: external stylesheets, fonts and images that need a network or CORS request
// are not drawn (inline styles, data: images and canvases are), and inner scroll offsets are not kept.
//
// `abstractHtml` is a pure string function (tested in Node): in abstract mode every run of text becomes a neutral grey bar,
// so layout, colors and spacing remain and nothing readable is left.
(() => {
  const ABSTRACT_CSS = '.hx-abs{color:transparent!important;text-shadow:none!important;text-decoration:none!important;border-radius:2px;'
    + 'background:linear-gradient(transparent 24%,rgba(128,128,128,.55) 24%,rgba(128,128,128,.55) 76%,transparent 76%)!important}'
    + 'input::placeholder,textarea::placeholder{color:transparent!important}svg text{fill:transparent!important;stroke:none!important}';

  /** XHTML string (as made by XMLSerializer) -> the same with every non-blank text run wrapped in <span class="hx-abs">.
   *  Text inside <style>, <script>, <title> stays alone; SVG <text> is left to the stylesheet (it has no boxes to color). */
  function abstractHtml(xhtml) {
    let svg = 0; let foreign = 0; let raw = null;
    return String(xhtml).replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g, (tok) => {
      if (tok[0] === '<') {
        const m = /^<(\/?)([A-Za-z][\w:.-]*)/.exec(tok);
        if (!m) return tok;
        const name = m[2].toLowerCase(); const close = !!m[1]; const self = /\/>$/.test(tok);
        if (raw) { if (close && name === raw) raw = null; return tok; }
        if (!close && !self && ['style', 'script', 'title'].includes(name)) raw = name;
        if (name === 'svg') svg = Math.max(0, svg + (close ? -1 : self ? 0 : 1));
        if (name === 'foreignobject') foreign = Math.max(0, foreign + (close ? -1 : self ? 0 : 1));
        return tok;
      }
      if (raw || (svg > 0 && foreign === 0) || !tok.trim()) return tok;
      return tok.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_, a, t, z) => `${a}<span class="hx-abs">${t}</span>${z}`);
    });
  }

  const MAX_SIDE = 8000; const MAX_PIXELS = 48e6;
  const loadImage = (src) => new Promise((resolve, reject) => {
    const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('the browser could not draw the page (too large, or it contains something the renderer cannot handle)')); img.src = src;
  });

  /** Fixes what a plain clone loses (form values, canvas pixels, images); originals and clones match by document order. */
  function copyLiveState(root, clone, abstract) {
    const tas = [...root.querySelectorAll('textarea')]; const ctas = [...clone.querySelectorAll('textarea')];
    for (const [i, o] of tas.entries()) {
      const c = ctas[i]; c.textContent = o.value;
      if (abstract) {
        const cs = getComputedStyle(o); const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
        const pad = parseFloat(cs.paddingTop) || 0; const rows = Math.max(0, Math.round((o.scrollHeight - pad - (parseFloat(cs.paddingBottom) || 0)) / lh));
        const bar = 'rgba(128,128,128,.55)';
        if (o.value.trim()) c.style.cssText += `;color:transparent;background-image:repeating-linear-gradient(to bottom,transparent 0,transparent ${lh * 0.24}px,${bar} ${lh * 0.24}px,${bar} ${lh * 0.76}px,transparent ${lh * 0.76}px,transparent ${lh}px);background-size:75% ${rows * lh}px;background-repeat:no-repeat;background-position:${parseFloat(cs.paddingLeft) || 0}px ${pad}px`;
      }
    }
    const ins = [...root.querySelectorAll('input')]; const cins = [...clone.querySelectorAll('input')];
    ins.forEach((o, i) => {
      const c = cins[i]; if (!c) return;
      if (o.checked) c.setAttribute('checked', ''); else c.removeAttribute('checked');
      if (abstract) { c.removeAttribute('value'); c.removeAttribute('placeholder'); } else if (o.type !== 'checkbox' && o.type !== 'radio') c.setAttribute('value', o.value);
    });
    const sels = [...root.querySelectorAll('select')]; const csels = [...clone.querySelectorAll('select')];
    sels.forEach((o, i) => { [...csels[i].options].forEach((op, k) => { if (o.options[k]?.selected) op.setAttribute('selected', ''); else op.removeAttribute('selected'); }); });
    const cvs = [...root.querySelectorAll('canvas')]; const ccvs = [...clone.querySelectorAll('canvas')];
    cvs.forEach((o, i) => {
      try { const img = document.createElement('img'); img.src = o.toDataURL(); img.style.cssText = `width:${o.clientWidth}px;height:${o.clientHeight}px`; ccvs[i].replaceWith(img); } catch { /* tainted: left blank */ }
    });
    const imgs = [...root.querySelectorAll('img')]; const cimgs = [...clone.querySelectorAll('img')];
    imgs.forEach((o, i) => {
      if (!o.complete || !o.naturalWidth || /^data:/.test(o.src)) return;
      try { const k = document.createElement('canvas'); k.width = o.naturalWidth; k.height = o.naturalHeight; k.getContext('2d').drawImage(o, 0, 0); cimgs[i].setAttribute('src', k.toDataURL()); } catch { /* cross-origin: not drawn */ }
    });
  }

  /** Renders this document to a PNG. Resolves { blob, width, height } (CSS pixels; the bitmap is width*scale wide). */
  async function render({ abstract = false, scale = 2 } = {}) {
    const de = document.documentElement;
    const w = Math.min(MAX_SIDE, Math.max(1, Math.ceil(Math.max(de.clientWidth, de.scrollWidth, innerWidth))));
    const h = Math.min(MAX_SIDE, Math.max(1, Math.ceil(Math.max(de.clientHeight, de.scrollHeight, innerHeight))));
    if (innerWidth < 2 || innerHeight < 2) throw new Error('the window has no size (is it minimized?); restore it and try again');
    const s = Math.max(0.25, Math.min(Number(scale) || 2, Math.sqrt(MAX_PIXELS / (w * h))));
    const clone = de.cloneNode(true);
    clone.querySelectorAll('script, link[rel~=stylesheet], noscript').forEach((n) => n.remove());
    // the clone is no longer the root inside the SVG, so a stylesheet's :root rules are pointed at html instead
    clone.querySelectorAll('style').forEach((n) => { n.textContent = n.textContent.replace(/:root\b/g, 'html'); });
    copyLiveState(de, clone, abstract);
    const bg = [document.body, de].map((n) => getComputedStyle(n).backgroundColor).find((c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') || '#ffffff';
    clone.style.cssText += `;width:${w}px;height:${h}px;background:${bg};margin:0`;
    let xml = new XMLSerializer().serializeToString(clone);
    if (abstract) xml = abstractHtml(xml.replace(/<\/head>/, `<style>${ABSTRACT_CSS}</style></head>`));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><foreignObject x="0" y="0" width="${w}" height="${h}">${xml}</foreignObject></svg>`;
    const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    const canvas = document.createElement('canvas'); canvas.width = Math.round(w * s); canvas.height = Math.round(h * s);
    const g = canvas.getContext('2d'); g.fillStyle = bg; g.fillRect(0, 0, canvas.width, canvas.height); g.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the browser could not encode the PNG'))), 'image/png'));
    return { blob, width: w, height: h, scale: s };
  }

  const api = { abstractHtml, render, ABSTRACT_CSS };
  if (typeof window !== 'undefined') window.hatchShot = api;
})();
