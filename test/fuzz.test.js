import test from 'node:test';
import assert from 'node:assert/strict';
import { startHatch } from './helpers.js';

// Every route gets hostile bodies and parameters. The contract: never a 500, and the server stays up.
const ROUTES = [
  ['POST', '/api/term/input'], ['POST', '/api/term/resize'], ['POST', '/api/pterm/x'], ['POST', '/api/pterm/x/input'], ['POST', '/api/pterm/x/resize'],
  ['POST', '/api/panels'], ['PATCH', '/api/panels/p1'], ['DELETE', '/api/panels/nope'],
  ['PUT', '/api/progress/steps'], ['PATCH', '/api/progress/steps/a'], ['POST', '/api/notify'], ['POST', '/api/copy'], ['POST', '/api/ask'], ['POST', '/api/ask/q1/answer'],
  ['PUT', '/api/widgets/w'], ['POST', '/api/sub'], ['PUT', '/api/commands'], ['PUT', '/api/watches'], ['POST', '/api/runs'], ['PUT', '/api/fs/write'],
  ['POST', '/api/desktop'],
];
const BODIES = ['null', '[]', '0', '"str"', '{}', '{"x":1}', '{"type":null,"props":null}', '{"text":[],"path":{},"data":5,"index":"a","cols":"x"}', '{"question":[],"choices":"no"}', '[{"name":1}]', '{"files":null}', '{'];
const QUERIES = ['', '?path=', '?path=%00', '?path=..%2f..%2f', '?dir=/&name=', '?cid=&x=1'];
const GETS = ['/api/fs/list', '/api/fs/read', '/api/fs/resolve', '/api/fs/download', '/api/file', '/api/runs/rx', '/api/ask/q9', '/api/progress/history/x.mmd', '/api/source/a/b', '/proxy/1/', '/proxy/99999/x', '/widgets/..%2f..%2fconfig.json', '/files/uploads/..%2fconfig.json', '/%00', '/api/nope'];

test('fuzz: no route answers 500 or kills the server', { timeout: 120000 }, async () => {
  const h = await startHatch();
  const bad = [];
  try {
    for (const [m, r] of ROUTES) for (const b of BODIES) {
      const res = await fetch(h.base + r, { method: m, headers: { 'x-token': h.hatch.token, 'content-type': 'application/json' }, body: b }).catch((e) => ({ status: `fetch error ${e.cause?.code || e.message}` }));
      if (typeof res.status !== 'number' || res.status >= 500) bad.push(`${m} ${r} ${b} -> ${res.status}`);
      await res.arrayBuffer?.().catch(() => {});
    }
    for (const g of GETS) for (const q of QUERIES) {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch(h.base + g + q, { headers: { 'x-token': h.hatch.token }, signal: ctl.signal }).catch((e) => ({ status: e.name === 'AbortError' ? 200 : `fetch error ${e.cause?.code || e.message}` })); // an SSE route stays open: abort is fine
      clearTimeout(t);
      if (typeof res.status !== 'number' || (res.status >= 500 && !(res.status === 502 && g.startsWith('/proxy/')))) bad.push(`GET ${g}${q} -> ${res.status}`); // 502 from the proxy to a closed port is the right answer
      ctl.abort();
    }
    assert.equal((await h.call('GET', '/api/health')).status, 200, 'server still answers');
  } finally { await h.close(); }
  assert.deepEqual(bad, []);
});
