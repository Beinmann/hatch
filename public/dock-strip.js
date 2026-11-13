// Dock scroll zone: a narrow area at the dock's right edge where the mouse wheel ALWAYS scrolls the dock,
// even though widgets inside the dock may have scrollable areas of their own that would capture the wheel.
// The indicator math is pure (tested in test/dock-strip.test.js); createDockStrip wires it to the DOM.
export const MIN_THUMB = 24;

/** Indicator size and position inside the zone. view = visible dock height, total = content height, scroll = scrollTop. */
export function thumbGeometry({ track, view, total, scroll, min = MIN_THUMB }) {
  if (!(track > 0) || !(total > view) || !(view > 0)) return { visible: false, height: 0, top: 0 };
  const height = Math.min(track, Math.max(min, track * (view / total)));
  const maxScroll = total - view;
  const s = Math.max(0, Math.min(maxScroll, scroll));
  return { visible: true, height, top: (s / maxScroll) * (track - height) };
}

/** Wheel delta in pixels; line and page modes (Firefox, some mice) are converted. */
export function wheelPixels(e, view) {
  return e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * view : e.deltaY;
}

export function createDockStrip({ dock, strip }) {
  const thumb = document.createElement('div'); thumb.className = 'thumb';
  strip.appendChild(thumb);
  let queued = false; let fade = 0;
  const paint = () => {
    queued = false;
    const g = thumbGeometry({ track: strip.clientHeight, view: dock.clientHeight, total: dock.scrollHeight, scroll: dock.scrollTop });
    thumb.hidden = !g.visible;
    if (g.visible) { thumb.style.height = `${g.height}px`; thumb.style.top = `${g.top}px`; }
  };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };
  const flash = () => { strip.classList.add('scrolling'); clearTimeout(fade); fade = setTimeout(() => strip.classList.remove('scrolling'), 700); };
  dock.addEventListener('scroll', () => { schedule(); flash(); }, { passive: true });
  // Not passive: we take the wheel so inner scrollable widgets under the pointer cannot swallow it.
  strip.addEventListener('wheel', (e) => {
    e.preventDefault(); e.stopPropagation();
    dock.scrollTop += wheelPixels(e, dock.clientHeight);
  }, { passive: false });
  const ro = new ResizeObserver(schedule);
  ro.observe(dock); ro.observe(strip);
  const watchKids = () => { for (const k of dock.children) ro.observe(k); schedule(); };
  new MutationObserver(watchKids).observe(dock, { childList: true });
  watchKids();
  return { refresh: schedule };
}
