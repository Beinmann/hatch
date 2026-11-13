// Reverse proxy to the box's own localhost: /proxy/PORT/path -> http://127.0.0.1:PORT/path (HTTP and WebSocket upgrade).
// Why: an iframe's URL is loaded by the BROWSER, where `localhost` means the user's own machine. Through the proxy a dev
// server that listens only on the box's localhost becomes reachable. Limits: root-absolute URLs in HTML (src="/x") are
// rewritten, but URLs built in JavaScript are not; servers that need their own origin may not work. Access is
// limited to 127.0.0.1 and requires the Hatch token like everything else (the Hatch cookie is not forwarded).
import http from 'node:http';
import net from 'node:net';

const RE = /^\/proxy\/(\d{1,5})(\/.*)?$/;

/** Parses a request path. Returns { port, rest } or null. */
export function parseProxyPath(urlPath) {
  const m = RE.exec(urlPath);
  if (!m) return null;
  const port = Number(m[1]);
  if (port < 1 || port > 65535) return null;
  return { port, rest: m[2] || '/' };
}

const stripHatchCookie = (c) => String(c || '').split(';').map((x) => x.trim()).filter((x) => x && !x.startsWith('hatch_token=') && !x.startsWith('hatch_session=')).join('; ');

function upstreamHeaders(req, port) {
  const h = { ...req.headers, host: `127.0.0.1:${port}` };
  delete h['x-token']; delete h.origin; delete h.referer;
  const cookie = stripHatchCookie(h.cookie); if (cookie) h.cookie = cookie; else delete h.cookie;
  return h;
}

/** Root-absolute src/href/action in HTML point at the proxy instead of at the Hatch root. */
export function rewriteHtml(html, port) {
  return html.replace(/(\s(?:src|href|action|poster)\s*=\s*["'])\/(?!\/)/gi, `$1/proxy/${port}/`);
}

export function rewriteLocation(loc, port) {
  if (loc.startsWith('/') && !loc.startsWith('//')) return `/proxy/${port}${loc}`;
  const m = new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}(/.*)?$`, 'i').exec(loc);
  return m ? `/proxy/${port}${m[2] || '/'}` : loc;
}

export function proxyHttp(req, res, { port, rest }, { selfPort } = {}) {
  const fail = (status, error) => { if (!res.headersSent) { res.writeHead(status, { 'content-type': 'application/json' }); } res.end(JSON.stringify({ error })); };
  if (port === selfPort) return fail(400, 'refusing to proxy Hatch to itself');
  const headers = upstreamHeaders(req, port);
  headers['accept-encoding'] = 'identity'; // HTML is rewritten, so it must not arrive compressed
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: rest, headers }, (r) => {
    const out = { ...r.headers };
    delete out['x-frame-options']; // the whole point is to show it in a Hatch window
    if (out['content-security-policy']) out['content-security-policy'] = String(out['content-security-policy']).replace(/frame-ancestors[^;]*;?/i, '');
    if (out.location) out.location = rewriteLocation(out.location, port);
    if (/^text\/html/i.test(out['content-type'] || '')) {
      const chunks = []; r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const body = Buffer.from(rewriteHtml(Buffer.concat(chunks).toString('utf8'), port));
        delete out['transfer-encoding']; out['content-length'] = body.length;
        res.writeHead(r.statusCode, out); res.end(body);
      });
      return;
    }
    res.writeHead(r.statusCode, out); r.pipe(res);
  });
  res.on('close', () => up.destroy()); // the browser left (iframe closed, long-poll or SSE aborted)
  up.on('error', (e) => fail(502, `nothing answered on 127.0.0.1:${port} (${e.code || e.message}). Is the dev server running on the box?`));
  req.pipe(up);
}

/** WebSocket (or any Upgrade) tunnel, so dev-server hot reload works through the proxy. */
export function proxyUpgrade(req, socket, head, { port, rest }) {
  const up = net.connect(port, '127.0.0.1');
  const headers = upstreamHeaders(req, port);
  up.on('connect', () => {
    up.write(`${req.method} ${rest} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    socket.pipe(up); up.pipe(socket);
  });
  const end = () => { socket.destroy(); up.destroy(); };
  up.on('error', end); socket.on('error', end); up.on('close', end); socket.on('close', end);
}
