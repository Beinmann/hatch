// Closing a window: ask the server to delete the panel, and make sure the page drops the window either way.
// The server's panel event normally removes it; when the panel is already gone ("no panel", 404) or the event
// never came, the window must not stay open as a zombie, so we remove it ourselves.

/** `isGone(err)`: the server says the panel does not exist any more. */
export function isGone(err) { return err?.status === 404 || /^no panel\b/.test(err?.message || ''); }

/** Delete `id` through `del()`; a vanished panel counts as success and `remove(id)` runs. Other errors go to `onError`. */
export async function closePanel(id, { del, remove, onError }) {
  try { await del(); return true; }
  catch (e) {
    if (isGone(e)) { remove(id); return true; }
    onError?.(e); return false;
  }
}

/** Run `fn` and swallow its error (reported through `warn`), so one failing step cannot skip the steps after it. */
export function safely(fn, warn) { try { return fn(); } catch (e) { warn?.(e); return undefined; } }
