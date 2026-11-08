import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHatch } from '../src/server.js';

export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-test-'));
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

/** A real server on an ephemeral port with `cat` instead of tmux, and a temp state dir. */
export async function startHatch(opts = {}) {
  const dir = tmp();
  const hatch = createHatch({ stateDir: path.join(dir, '.hatch'), host: '127.0.0.1', port: 0, attach: ['cat'], cwd: dir, pollState: true, findBin: () => null, ...opts });
  const port = await hatch.listen();
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, route, body, headers = {}) => {
    const res = await fetch(base + route, { method, headers: { 'x-token': hatch.token, ...(body && !Buffer.isBuffer(body) && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text(); let data = text; try { data = JSON.parse(text); } catch { /* plain */ }
    return { status: res.status, data };
  };
  return { hatch, dir, base, port, call, stateDir: path.join(dir, '.hatch'), close: () => hatch.close() };
}

/** Reads an SSE response until `until(events)` holds; events are { event, data }. */
export async function readSse(url, headers, until, ms = 4000) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms);
  const events = []; let buf = '';
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1] || 'message'; const data = /^data: (.*)$/m.exec(block)?.[1];
        if (data !== undefined) events.push({ event, data });
      }
      if (until(events)) break;
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { clearTimeout(timer); ctl.abort(); }
  return events;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(40); } throw new Error('timed out waiting for condition'); }

/** Questions have opaque IDs; clients discover pending ones through the normal events snapshot. */
export async function pendingAsks(h) {
  const events = await readSse(`${h.base}/api/events`, { 'x-token': h.hatch.token }, list => list.some(event => event.event === 'snapshot'));
  return JSON.parse(events.find(event => event.event === 'snapshot').data).asks;
}
