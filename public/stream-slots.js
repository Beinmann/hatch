// Browsers allow ~6 HTTP/1.1 connections per origin and every live terminal or output window holds one EventSource open.
// Past that limit input POSTs and close requests queue behind the streams and the page looks hung (restoring 20 closed windows
// did exactly that). Windows take a slot before opening a stream; the rest wait their turn and start when one is released.
export function createSlots(max) {
  let used = 0; const waiting = [];
  const pump = () => { while (used < max && waiting.length) { const w = waiting.shift(); used++; w.held = true; w.grant(); } };
  return {
    /** Calls grant() now or later. The lease's release() frees the slot, or leaves the queue; calling it twice is fine. */
    acquire(grant) {
      const w = { grant, held: false, done: false };
      waiting.push(w); pump();
      return {
        get waiting() { return !w.held && !w.done; },
        release() {
          if (w.done) return; w.done = true;
          if (w.held) { used--; pump(); } else { const i = waiting.indexOf(w); if (i >= 0) waiting.splice(i, 1); }
        },
      };
    },
    get used() { return used; },
  };
}
// 6 connections minus /api/events, the main terminal and one spare for requests.
export const streamSlots = createSlots(3);
