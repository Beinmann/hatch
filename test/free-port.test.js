import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHatch } from '../src/server.js';
import { listenFromPort } from '../src/free-port.js';
import { tmp } from './helpers.js';

const SERVER = fileURLToPath(new URL('../bin/hatch-server.js', import.meta.url));
const busy = (port, host = '0.0.0.0') => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(port, host, () => resolve(s)); });
const freePort = async () => { const s = await busy(0); const { port } = s.address(); await new Promise((r) => s.close(r)); return port; };
const mk = (dir) => createHatch({ stateDir: path.join(dir, '.hatch'), port: 0, host: '127.0.0.1', session: 'hatch-test-port', attach: () => {}, tmuxBin: 'cat' });

test('without --port a taken port moves to the next free one and config.json records it', async () => {
  const a = await busy(await freePort(), '127.0.0.1'); const first = a.address().port;
  const dir = tmp(); const h = mk(dir);
  try {
    const r = await listenFromPort(h, first);
    assert.equal(r.moved, true); assert.ok(r.port > first);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.hatch', 'config.json'), 'utf8')).port, r.port, 'clients read the port from config.json');
  } finally { await h.close(); a.close(); }
});

test('a free first port is used as is; an explicit taken port fails with EADDRINUSE; the number of tries is limited', async () => {
  const dir = tmp(); const h = mk(dir); const p = await freePort();
  const a = await busy(p, '127.0.0.1');
  try {
    await assert.rejects(listenFromPort(h, p, { explicit: true }), { code: 'EADDRINUSE' });
    await assert.rejects(listenFromPort(h, p, { tries: 1 }), { code: 'EADDRINUSE' }, 'gives up after the allowed number of tries');
    await new Promise((r) => a.close(r));
    const r = await listenFromPort(h, p); assert.deepEqual(r, { port: p, moved: false });
  } finally { await h.close(); }
});

test('hatch-server serve --port N with N taken exits 1 with a message that names the port', async () => {
  const a = await busy(await freePort()); const p = a.address().port; const dir = tmp();
  try {
    const r = await new Promise((resolve) => {
      const c = spawn('node', [SERVER, 'serve', '--port', String(p), '--state', path.join(dir, '.hatch'), '--yes', '--host', '127.0.0.1'], { env: { ...process.env, HATCH_STATE: '', HATCH_URL: '' } });
      let err = ''; c.stderr.on('data', (d) => { err += d; }); c.on('close', (status) => resolve({ status, err }));
    });
    assert.equal(r.status, 1); assert.match(r.err, new RegExp(`port ${p} is in use`));
  } finally { a.close(); }
});
