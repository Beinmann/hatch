// Bounded delivery for one SSE response. Producers never wait on a browser's socket.
export function createSseWriter(req, res, { maxQueuedBytes = 2 * 1024 * 1024, stallMs = 30000, onClose = () => {}, log = () => {} } = {}) {
  if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes < 1 || !Number.isFinite(stallMs) || stallMs <= 0 || stallMs > 0x7fffffff) throw new Error('stream queue bytes and stall timeout must be positive values within their supported limits');
  const client = { req, res, queue: [], bytes: 0, blocked: false, closed: false, ending: false, stall: null };
  function finish(client, destroy = false) {
    if (client.closed) return;
    client.closed = true; clearTimeout(client.stall);
    client.queue.length = 0; client.bytes = 0;
    client.req.off('close', client.onClose); client.res.off('close', client.onClose); client.res.off('finish', client.onClose); client.res.off('drain', client.onDrain);
    try { onClose(); } catch (error) { log(`event stream cleanup failed: ${error.message}`); }
    if (destroy) { try { client.res.destroy(); } catch { /* already disconnected */ } }
  }
  function write(client, frame) {
    if (client.closed) return;
    if (client.res.destroyed || client.res.writableEnded) return finish(client);
    try {
      if (client.res.write(frame) === false) {
        client.blocked = true;
        client.stall = setTimeout(() => finish(client, true), stallMs); client.stall.unref();
      }
    } catch { finish(client, true); }
  }
  function send(client, frame, bytes = Buffer.byteLength(frame)) {
    if (client.closed) return;
    if (client.res.destroyed || client.res.writableEnded) return finish(client, client.blocked);
    if (!client.blocked) return write(client, frame);
    if (client.bytes + bytes > maxQueuedBytes) return finish(client, true);
    client.queue.push({ frame, bytes }); client.bytes += bytes;
  }
  function drain(client) {
    if (client.closed) return;
    clearTimeout(client.stall); client.blocked = false;
    while (client.queue.length && !client.blocked && !client.closed) {
      const item = client.queue.shift(); client.bytes -= item.bytes; write(client, item.frame);
    }
  }

  function complete() {
    if (client.ending && !client.closed && !client.blocked && !client.queue.length) {
      try { res.end(); } catch { finish(client, true); }
    }
  }
  client.onClose = () => finish(client); client.onDrain = () => { drain(client); complete(); };
  req.once('close', client.onClose); res.once('close', client.onClose); res.once('finish', client.onClose);
  res.on('drain', client.onDrain);
  // Late socket errors must remain handled even after close has already released caller bookkeeping.
  res.on('error', () => finish(client, true));
  return {
    write(frame, bytes) { if (!client.ending) send(client, frame, bytes); },
    end(frame) { if (client.closed || client.ending) return; if (frame) send(client, frame); client.ending = true; complete(); },
    destroy() { finish(client, true); },
    get backedUp() { return client.blocked || client.queue.length > 0; },
  };
}
