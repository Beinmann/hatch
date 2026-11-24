// One path for giving a window real keyboard focus (Ctrl+N, leader N, chips, restore, leader h/j/k/l, palette).
// The window frame is only a fallback target: keys reach a panel's own handlers only when focus sits inside the
// panel's content, so after the view's own focus() ran we check where focus really is and fall back to the first
// focusable element of the content (a panel without focus(), such as an iframe or page window, still gets the keyboard).
// Pure duck-typed logic on nodes (focus, contains, matches, querySelector), so it is tested without a browser.
export const FOCUSABLE = 'iframe, textarea, input:not([type="hidden"]), select, [contenteditable="true"], [tabindex]:not([tabindex^="-"]), button, a[href]';

const FOCUS_OPTS = { preventScroll: true };

/** The element that should take the keyboard for a view: its root when focusable, else the first focusable child. */
export function contentTarget(viewEl) {
  if (!viewEl) return null;
  const t = viewEl.getAttribute?.('tabindex');
  if (t != null && !String(t).startsWith('-') && viewEl.matches?.(FOCUSABLE)) return viewEl;
  return viewEl.querySelector?.(FOCUSABLE) || null;
}

/** Focus a window's content. Returns true when the real focus ends up inside the window's content (a widget iframe counts).
 *  `doc` supplies activeElement (the document in a browser). */
export function focusWindowContent(w, doc) {
  // the frame itself does not count: keys on it never reach the panel's own handlers
  const inside = () => !!doc.activeElement && doc.activeElement !== w.node && w.node.contains(doc.activeElement);
  w.node.focus?.(FOCUS_OPTS);
  try { w.view?.focus?.(); } catch { /* a view may not be ready yet; the fallback below and the retry cover it */ }
  if (!inside()) { const t = contentTarget(w.view?.el); try { t?.focus?.(FOCUS_OPTS); } catch { /* ignore */ } }
  return inside();
}

/** Whether a delayed second attempt is still wanted: the window is still the one marked focused and nothing else has
 *  taken the keyboard (focus is on the page body or nowhere, or still on the window frame itself). */
export function wantsRetry({ stillFocused, active, body, node }) {
  if (!stillFocused) return false;
  return !active || active === body || active === node;
}
