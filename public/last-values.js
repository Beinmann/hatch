// Last value per widget source. Moving a widget between dock and float reloads its iframe while the host keeps the
// source subscription (so the server sends nothing new); the fresh page asks again and gets this replayed at once.
export function createLastValues() {
  const last = new Map();
  return {
    set(source, value, ts) { last.set(source, { value, ts }); },
    replay(source, fn) { const v = last.get(source); if (v) fn(v.value, v.ts); return !!v; },
    clear() { last.clear(); },
  };
}
