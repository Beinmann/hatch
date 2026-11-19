// What a click on a window's taskbar chip does (Windows-like): a minimized window is restored and focused, the
// window that has focus (on screen) is minimized, anything else is brought to the front and focused.
export function chipClickAction({ minimized, onScreen, focused }) {
  if (minimized) return 'restore';
  return onScreen && focused ? 'minimize' : 'focus';
}

// What Ctrl+N does for the window behind number N: restore a minimized one, minimize one that is already open (on screen),
// otherwise (e.g. a docked window while the dock is closed) bring it forward. Without toggle (leader + number) it never minimizes.
export function numberKeyAction({ minimized, onScreen, toggle }) {
  if (minimized) return 'restore';
  return toggle && onScreen ? 'minimize' : 'focus';
}

// A press on a chip moves focus before the click arrives (the page or the widget frame loses it, the window-focus handler may
// blur the windows and repaint the bar). So the focused state is captured on pointerdown, before any of that, and the click
// uses it; while a press is open the bar must not be rebuilt, or the button under the pointer is replaced and the click is lost.
export function createChipPress() {
  let seen = new Map(); let open = false; let dirty = false;
  return {
    down(id, focused) { seen.set(id, !!focused); open = true; },
    // The state captured on the matching pointerdown; falls back to the live value for keyboard clicks (no press).
    focusedAt(id, live) { return seen.has(id) ? seen.get(id) : !!live; },
    // Call from paint: true means "skip now, I will tell you when to repaint".
    deferPaint() { if (!open) return false; dirty = true; return true; },
    // After the click (or a cancelled press): forget the press; returns true when a repaint was skipped meanwhile.
    up() { open = false; seen = new Map(); const d = dirty; dirty = false; return d; },
  };
}

// Is this window focused right now: marked focused, or the real focus sits inside it (terminal, widget iframe, editor).
export function windowFocused(node, active) {
  return !!node && (node.classList.contains('focus') || (!!active && node.contains(active)));
}
