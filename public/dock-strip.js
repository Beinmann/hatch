// Dock strip: a quiet, opaque rail at the far right edge that scrolls the dock (not the terminal).
// The math is pure (tested in test/dock-strip.test.js); createDockStrip wires it to the DOM.
export const MIN_THUMB = 24;

/** Thumb size and position inside a track. view = visible dock height, total = content height, scroll = scrollTop. */
export function thumbGeometry({ track, view, total, scroll, min = MIN_THUMB }) {
  if (!(track > 0) || !(total > view) || !(view > 0)) return { visible: false, height: 0, top: 0 };
  const height = Math.min(track, Math.max(min, track * (view / total)));
  const maxScroll = total - view;
  const s = Math.max(0, Math.min(maxScroll, scroll));
  return { visible: true, height, top: (s / maxScroll) * (track - height) };
}

/** Dock scrollTop for a thumb dragged dy pixels from where it started at startScroll. */
export function scrollForDrag({ startScroll, dy, track, thumb, view, total }) {
  const room = track - thumb; const maxScroll = total - view;
  if (!(room > 0) || !(maxScroll > 0)) return 0;
  return Math.max(0, Math.min(maxScroll, startScroll + (dy / room) * maxScroll));
}

export function createDockStrip({ dock, strip }) {
  const thumb = document.createElement('div'); thumb.className = 'thumb';
  strip.appendChild(thumb);
  let queued = false;
  const paint = () => {
    queued = false;
    const g = thumbGeometry({ track: strip.clientHeight, view: dock.clientHeight, total: dock.scrollHeight, scroll: dock.scrollTop });
    thumb.hidden = !g.visible;
    if (g.visible) { thumb.style.height = `${g.height}px`; thumb.style.top = `${g.top}px`; }
  };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };
  dock.addEventListener('scroll', schedule, { passive: true }); // wheel scrolling is the dock's own; the thumb just follows it
  const ro = new ResizeObserver(schedule);
  ro.observe(dock); ro.observe(strip);
  const watchKids = () => { for (const k of dock.children) ro.observe(k); schedule(); };
  new MutationObserver(watchKids).observe(dock, { childList: true });
  watchKids();

  thumb.addEventListener('pointerdown', (e) => {
    e.preventDefault(); thumb.setPointerCapture(e.pointerId); thumb.classList.add('on');
    const y0 = e.clientY; const s0 = dock.scrollTop;
    const move = (m) => {
      dock.scrollTop = scrollForDrag({ startScroll: s0, dy: m.clientY - y0, track: strip.clientHeight, thumb: thumb.offsetHeight, view: dock.clientHeight, total: dock.scrollHeight });
    };
    const up = () => { thumb.classList.remove('on'); thumb.removeEventListener('pointermove', move); thumb.removeEventListener('pointerup', up); thumb.removeEventListener('pointercancel', up); };
    thumb.addEventListener('pointermove', move); thumb.addEventListener('pointerup', up); thumb.addEventListener('pointercancel', up);
  });
  return { refresh: schedule };
}
