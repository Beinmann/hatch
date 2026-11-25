// State behind the clipboard bridge: drops a repeat of the same text, and keeps a text the browser refused to write until the
// next user gesture (a click or key press), when the write is allowed. Pure logic: the page supplies write() and fallback().
export function createClipboardBridge({ write, fallback = async () => false, now = () => Date.now(), ttl = 30000, dedupeMs = 1000 }) {
  let last = null; // { text, at } of the previous receive()
  let pending = null; // { text, at } waiting for a gesture
  const live = () => { if (pending && now() - pending.at > ttl) pending = null; return pending; };
  return {
    /** 'duplicate' (ignored), 'copied' or 'pending' (needs a gesture; see flush). */
    async receive(text) {
      const t = now();
      if (last && last.text === text && t - last.at < dedupeMs) return 'duplicate';
      last = { text, at: t };
      pending = null; // a newer text replaces an older waiting one
      try { await write(text); return 'copied'; } catch { /* needs a gesture */ }
      pending = { text, at: t };
      return 'pending';
    },
    hasPending: () => !!live(),
    /** Call inside a user gesture: write() starts synchronously. true when copied, false when refused (stays pending), null when nothing waits. */
    async flush() {
      const p = live(); if (!p) return null;
      pending = null;
      let ok = true;
      try { await write(p.text); } catch { ok = await fallback(p.text); }
      if (!ok && !pending) pending = p;
      return ok;
    },
    clear() { pending = null; },
  };
}
