import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { parseProxyPath, rewriteHtml, rewriteLocation } from '../src/proxy.js';
import { startHatch } from './helpers.js';

test('parseProxyPath, rewriteHtml and rewriteLocation', () => {
  assert.deepEqual(parseProxyPath('/proxy/3000/a/b'), { port: 3000, rest: '/a/b' });
  assert.deepEqual(parseProxyPath('/proxy/3000'), { port: 3000, rest: '/' });
  assert.equal(parseProxyPath('/proxy/0/x'), null); assert.equal(parseProxyPath('/proxy/70000/x'), null); assert.equal(parseProxyPath('/proxyx/1/x'), null);
  assert.equal(rewriteHtml('<img src="/a.png"><a href="/x">k</a><script src="//cdn/x.js"></script><a href="rel">', 8080), '<img src="/proxy/8080/a.png"><a href="/proxy/8080/x">k</a><script src="//cdn/x.js"></script><a href="rel">');
  assert.equal(rewriteLocation('/login', 80), '/proxy/80/login'); assert.equal(rewriteLocation('http://localhost:80/x', 80), '/proxy/80/x'); assert.equal(rewriteLocation('https://example.com/', 80), 'https://example.com/');
});

test('proxy forwards to the box localhost, rewrites html and redirects, hides the token, reports a dead port', async () => {
  const seen = {};
  const upstream = http.createServer((req, res) => {
    seen.url = req.url; seen.cookie = req.headers.cookie; seen.token = req.headers['x-token']; seen.host = req.headers.host;
    if (req.url === '/redir') { res.writeHead(302, { location: '/landing' }); return res.end(); }
    if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' }); return res.end('<img src="/logo.png">'); }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`got ${req.method} ${req.url}`);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r)); const up = upstream.address().port;
  const h = await startHatch();
  try {
    const get = (p, init = {}) => fetch(`${h.base}${p}`, { redirect: 'manual', ...init, headers: { 'x-token': h.hatch.token, ...init.headers } });
    assert.equal((await fetch(`${h.base}/proxy/${up}/x`)).status, 401, 'proxy needs the token');
    let r = await get(`/proxy/${up}/hello?a=1`, { headers: { cookie: `hatch_token=${h.hatch.token}; other=1` } });
    assert.equal(await r.text(), 'got GET /hello?a=1'); assert.equal(seen.cookie, 'other=1'); assert.equal(seen.token, undefined); assert.equal(seen.host, `127.0.0.1:${up}`);
    r = await get(`/proxy/${up}/page`); assert.equal(await r.text(), `<img src="/proxy/${up}/logo.png">`); assert.equal(r.headers.get('x-frame-options'), null);
    r = await get(`/proxy/${up}/redir`); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), `/proxy/${up}/landing`);
    r = await get(`/proxy/${up}/p`, { method: 'POST', body: 'x' }); assert.equal(await r.text(), 'got POST /p');
    const dead = net.createServer(); await new Promise((x) => dead.listen(0, '127.0.0.1', x)); const dp = dead.address().port; await new Promise((x) => dead.close(x));
    r = await get(`/proxy/${dp}/`); assert.equal(r.status, 502); assert.match((await r.json()).error, /nothing answered/);
    r = await get(`/proxy/${h.port}/`); assert.equal(r.status, 400, 'no self loop');
  } finally { await h.close(); await new Promise((r) => upstream.close(r)); }
});

test('proxy tunnels a WebSocket-style upgrade and refuses it without the token', async () => {
  const upstream = net.createServer((s) => {
    s.once('data', () => { s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); s.on('data', (d) => s.write(Buffer.concat([Buffer.from('echo:'), d]))); });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r)); const up = upstream.address().port;
  const h = await startHatch();
  const raw = (token) => new Promise((resolve) => {
    const s = net.connect(h.port, '127.0.0.1'); let buf = '';
    s.on('data', (d) => { buf += d; if (buf.includes('101') && !buf.includes('echo:')) s.write('ping'); if (buf.includes('echo:ping') || buf.includes('403')) { s.destroy(); resolve(buf); } });
    s.on('close', () => resolve(buf));
    s.write(`GET /proxy/${up}/ws HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n${token ? `x-token: ${token}\r\n` : ''}\r\n`);
  });
  try {
    assert.match(await raw(h.hatch.token), /101[\s\S]*echo:ping/);
    assert.match(await raw(null), /403/);
  } finally { await h.close(); await new Promise((r) => upstream.close(r)); }
});
