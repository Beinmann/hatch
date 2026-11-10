// Keep a floating window inside the area it floats in (the terminal side; the dock is a separate column, so a
// narrower area means the dock is open). Pure so it can be tested. Move first, shrink only when it cannot fit.
// The stored geometry is the user's intent: callers fit at render time and never write the result back,
// so a window returns to its place when the area grows again.
export function fitFloat({ x, y, w, h }, { width, height }, { minW = 180, minH = 90 } = {}) {
  const fw = Math.max(Math.min(minW, width), Math.min(w, width)); // never wider than the area (unless the area is tiny)
  const fh = Math.max(Math.min(minH, height), Math.min(h, height));
  const fx = Math.max(0, Math.min(x, width - fw)); const fy = Math.max(0, Math.min(y, height - fh));
  return { x: fx, y: fy, w: fw, h: fh };
}

// Live clamps for dragging, resizing and keyboard moves: the same rule as fitFloat (the window stays wholly inside the
// area), applied while the pointer moves so a window can never be dropped partly under the dock.
/** Position for a window of size {w,h} moved to (x,y): wholly inside the area. */
export function clampMove({ x, y }, { w, h }, { width, height }) {
  return { x: Math.max(0, Math.min(x, width - w)), y: Math.max(0, Math.min(y, height - h)) };
}
/** Size for a window whose top-left is at (x,y) resized to w x h: at least the minimum, never past the right or bottom edge
 *  (the edge wins over the minimum only when the window is already so close to it that the minimum cannot fit). */
export function clampResize({ x, y }, { w, h }, { width, height }, { minW = 180, minH = 90 } = {}) {
  const room = { w: Math.max(1, width - x), h: Math.max(1, height - y) };
  return { w: Math.max(Math.min(minW, room.w), Math.min(w, room.w)), h: Math.max(Math.min(minH, room.h), Math.min(h, room.h)) };
}
