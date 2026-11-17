// Shared by every animated effect: should this frame be skipped? True in a hidden tab, and also after IDLE_MS without any input in this
// page (a visible tab left on a screen all day would otherwise animate forever). Any pointer, key, wheel or touch input wakes it at once.
// Terminal output alone does not count as activity. Without a window (tests, other hosts) only the hidden-tab check applies.
export const IDLE_MS = 5 * 60 * 1000;
let lastInput = performance.now();
const EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'];
const wake = () => { lastInput = performance.now(); };
if (typeof globalThis.addEventListener === 'function') for (const e of EVENTS) globalThis.addEventListener(e, wake, { passive: true, capture: true });

export const paused = (now = performance.now()) => !!globalThis.document?.hidden || now - lastInput > IDLE_MS;
