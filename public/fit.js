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
