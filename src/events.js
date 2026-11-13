// One browser SSE stream carries state and widget events. Slow clients reconnect to a fresh snapshot.
import { createSseWriter } from './sse.js';
const HEARTBEAT_MS = 15000;

export function createBus(snapshot, { maxQueuedBytes = 2 * 1024 * 1024, stallMs = 30000, log = () => {} } = {}) {
  if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes < 1 || !Number.isFinite(stallMs) || stallMs <= 0 || stallMs > 0x7fffffff) throw new Error('event queue bytes and stall timeout must be positive values within their supported limits');
  const clients = new Map(); const metas = new Map(); let closed = false;
  const encode = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const cleanup = (onClose) => { try { onClose(); } catch (error) { log(`event stream cleanup failed: ${error.message}`); } };
  const timer = setInterval(() => { for (const writer of clients.values()) writer.write(': ping\n\n'); }, HEARTBEAT_MS);
  timer.unref();
  return {
    /** Send to every stream, or only to those whose meta (given to subscribe) `pick` accepts. Returns how many streams it went to. */
    emit(event, data, pick) {
      if (closed || !clients.size) return 0;
      const frame = encode(event, data); const bytes = Buffer.byteLength(frame); let n = 0;
      for (const [res, writer] of clients) { if (pick && !pick(metas.get(res))) continue; writer.write(frame, bytes); n++; }
      return n;
    },
    subscribe(req, res, onClose = () => {}, meta = {}) {
      if (closed) { cleanup(onClose); res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"event stream is closed"}'); return; }
      let initial;
      try { initial = encode('snapshot', snapshot(req)); } catch (error) { cleanup(onClose); throw error; }
      const writer = createSseWriter(req, res, { maxQueuedBytes, stallMs, log, onClose: () => { clients.delete(res); metas.delete(res); onClose(); } });
      clients.set(res, writer); metas.set(res, meta);
      try {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        writer.write('retry: 1000\n\n'); writer.write(initial);
      } catch (error) { writer.destroy(); throw error; }
    },
    size: () => clients.size,
    close() {
      if (closed) return; closed = true; clearInterval(timer);
      for (const writer of [...clients.values()]) { if (writer.backedUp) writer.destroy(); else writer.end(); }
    },
  };
}
