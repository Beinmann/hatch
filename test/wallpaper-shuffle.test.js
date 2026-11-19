// The Wallpaper shuffle example: its python backend run against a local HTTP server standing in for the image sources
// (base URLs come from WALLPAPER_* environment variables), with a stub `hatch` and optional fake `convert` on PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { startHatch } from './helpers.js';

const run = promisify(execFile);
const PY = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim(); // absolute, so a test may hide other tools from PATH
const SRC = new URL('../examples/widgets/wallpaper-shuffle/', import.meta.url).pathname;

/** A structurally valid JPEG (SOI, SOF with the given size, padding, EOI); enough for the backend's checks. */
function jpeg(w = 1920, h = 1080, pad = 40000) {
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]), sof, Buffer.alloc(pad, 7), Buffer.from([0xff, 0xd9])]);
}

/** A local stand-in for the three sources. `mode[name]` picks the behaviour per source: ok (default), 503, html, cut, tiny, drop. */
async function fakeSources() {
  const mode = {}; const hits = []; let picsumFails = 0;
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const send = (name, body, type = 'image/jpeg', extra = {}) => {
      const m = name === 'picsum' && picsumFails > 0 ? (picsumFails--, '503') : (mode[name] || 'ok');
      if (m === '503') { res.writeHead(503); return res.end('busy'); }
      if (m === 'drop') return req.socket.destroy();
      if (m === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><p>blocked</p>'); }
      if (m === 'cut') { res.writeHead(200, { 'content-type': type, 'content-length': body.length + 500 }); res.write(body); return res.end(); }
      if (m === 'tiny') body = jpeg(1920, 1080, 10);
      res.writeHead(200, { 'content-type': type, ...extra }); res.end(body);
    };
    if (req.url.startsWith('/picsum/id/')) return res.end(JSON.stringify({ author: 'Ann Author', url: 'https://example.invalid/p' }));
    if (req.url.startsWith('/picsum/')) return send('picsum', jpeg(), 'image/jpeg', { 'picsum-id': '42' });
    if (req.url.startsWith('/bing/HPImageArchive')) {
      if (mode.bing === '503') { res.writeHead(503); return res.end('x'); }
      return res.end(JSON.stringify({ images: [{ urlbase: '/th?id=OHR.Owls_EN1', title: 'Owls', copyright: 'Owls (© Zed/Getty)', copyrightlink: 'https://example.invalid/o' }] }));
    }
    if (req.url.startsWith('/bing/th')) return send('bingimg', jpeg());
    if (req.url.startsWith('/flickr/')) return send('flickr', jpeg());
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { mode, hits, failPicsum: (n) => { picsumFails = n; }, base, close: () => new Promise((r) => server.close(r)),
    env: { WALLPAPER_PICSUM: `${base}/picsum`, WALLPAPER_BING: `${base}/bing`, WALLPAPER_FLICKR: `${base}/flickr`, WALLPAPER_BACKOFF: '0', WALLPAPER_TIMEOUT: '3' } };
}

/** A widget copy in a temp state dir, a stub `hatch` that logs its arguments, and a runner for the backend. */
function setup(srv, { tools = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-wp-'));
  const state = path.join(root, 'state'); const dir = path.join(state, 'widgets', 'wallpaper-shuffle'); const bin = path.join(root, 'bin');
  fs.cpSync(SRC, dir, { recursive: true }); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'hatch'), '#!/bin/sh\necho "$@" >> "$(dirname "$0")/hatch.log"\n', { mode: 0o755 });
  for (const [name, script] of Object.entries(tools)) fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
  const data = path.join(dir, 'data');
  const py = async (cmd, arg, env = {}) => {
    const args = [path.join(dir, 'wallpaper.py'), state, cmd, ...(arg === undefined ? [] : [arg])];
    try {
      const r = await run(PY, args, { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...srv?.env, ...env } });
      return { code: 0, json: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
    } catch (e) { return { code: e.code, json: null, err: String(e.stderr).trim() }; }
  };
  // start a download and wait for the detached job to finish
  const fetchNow = async (env) => {
    const r = await py('fetch', undefined, env); assert.equal(r.code, 0, r.err);
    for (let i = 0; i < 100; i++) { const s = (await py('list', undefined, env)).json; if (s.job.state !== 'running') return s; await new Promise((x) => setTimeout(x, 100)); }
    throw new Error('the job did not finish');
  };
  const hatchLog = () => { try { return fs.readFileSync(path.join(bin, 'hatch.log'), 'utf8').trim().split('\n'); } catch { return []; } };
  return { root, state, dir, data, bin, py, fetchNow, hatchLog, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const leftovers = (data) => fs.readdirSync(data).filter((f) => f.startsWith('.tmp-') && !f.endsWith('.json') && f !== '.lock');
const jpgs = (data) => fs.readdirSync(data).filter((f) => f.endsWith('.jpg'));

test('download: picsum image + sidecar with author, set as background in the given state dir', async () => {
  const srv = await fakeSources(); const w = setup(srv);
  try {
    const s = await w.fetchNow();
    assert.equal(s.job.state, 'done', s.job.msg); assert.match(s.job.msg, /picsum\.photos/);
    assert.equal(s.images.length, 1); const i = s.images[0];
    assert.match(i.n, /^picsum-42-\d+\.jpg$/); assert.equal(i.m.author, 'Ann Author'); assert.equal(i.m.width, 1920); assert.equal(s.current, i.n);
    assert.ok(srv.hits.some((h) => h.startsWith('/picsum/1920/1080')), 'asks for a 1920x1080 image');
    assert.deepEqual(w.hatchLog(), [`set background ${path.join(w.data, i.n)} --state ${w.state}`]);
    assert.deepEqual(leftovers(w.data), []);
  } finally { await srv.close(); w.done(); }
});

test('fallback: picsum down -> bing; retry succeeds on the second try; error text names each source', async () => {
  const srv = await fakeSources(); const w = setup(srv);
  try {
    srv.mode.picsum = '503';
    let s = await w.fetchNow();
    assert.equal(s.job.state, 'done'); assert.match(s.images[0].n, /^bing-Owls_EN1-/); assert.equal(s.images[0].m.author, 'Zed/Getty'); assert.equal(s.images[0].m.title, 'Owls');
    assert.match(s.job.msg, /bing\.com.*after picsum\.photos: HTTP 503/);
    srv.mode.picsum = 'ok'; srv.failPicsum(1); // one failure, then fine: the retry of the same source wins
    s = await w.fetchNow(); assert.match(s.job.file, /^picsum-/); assert.equal(s.job.state, 'done');
    // flickr is the last resort
    srv.mode.picsum = '503'; srv.mode.bing = '503';
    s = await w.fetchNow(); assert.match(s.job.file, /^flickr-/);
    assert.match(s.job.msg, /picsum\.photos: HTTP 503[^;]*; bing\.com: HTTP 503/);
  } finally { await srv.close(); w.done(); }
});

test('failures: every source bad gives one readable line per source and leaves no files behind', async () => {
  const srv = await fakeSources(); const w = setup(srv);
  try {
    srv.mode.picsum = 'html'; srv.mode.bing = '503'; srv.mode.flickr = 'cut';
    const s = await w.fetchNow();
    assert.equal(s.job.state, 'error');
    assert.match(s.job.msg, /picsum\.photos: not a JPEG/); assert.match(s.job.msg, /bing\.com: HTTP 503/); assert.match(s.job.msg, /loremflickr\.com: the download was cut off/);
    assert.deepEqual(jpgs(w.data), []); assert.deepEqual(leftovers(w.data), []); assert.deepEqual(w.hatchLog(), []);
    // more bad inputs: tiny file, dropped connection, nothing listening
    srv.mode.picsum = 'tiny'; srv.mode.bing = 'ok'; srv.mode.bingimg = 'drop'; srv.mode.flickr = '503';
    let e = (await w.fetchNow()).job.msg; assert.match(e, /picsum\.photos: the file is only \d+ bytes/); assert.match(e, /bing\.com: (network error|.*(closed|reset|Remote|Connection))/);
    e = (await w.fetchNow({ WALLPAPER_PICSUM: 'http://127.0.0.1:9/p', WALLPAPER_SOURCES: 'picsum' })).job.msg;
    assert.match(e, /picsum\.photos: (connection refused|network error)/);
    assert.deepEqual(jpgs(w.data), []); assert.deepEqual(leftovers(w.data), []);
  } finally { await srv.close(); w.done(); }
});

test('validation: wrong shape and truncated JPEGs are refused', async () => {
  const srv = await fakeSources(); const w = setup(srv);
  try {
    const bad = [['portrait', jpeg(600, 1000)], ['small', jpeg(800, 450)], ['no end marker', jpeg().subarray(0, 5000)]];
    for (const [label, buf] of bad) {
      const f = path.join(w.root, 'x.jpg'); fs.writeFileSync(f, buf);
      const r = await run('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(w.dir)}); import wallpaper as w
try:
    w.validate(open(${JSON.stringify(f)}, 'rb').read()); print('ok')
except w.Fail as e: print('refused: ' + str(e))`]);
      assert.match(r.stdout, /refused/, label);
    }
  } finally { await srv.close(); w.done(); }
});

test('dark check: a too dark image is skipped, a bright one kept, no tool means no check', async () => {
  const srv = await fakeSources();
  const dark = setup(srv, { tools: { convert: '#!/bin/sh\necho 12.5\n' } });
  const bright = setup(srv, { tools: { convert: '#!/bin/sh\necho 120\n' } });
  const none = setup(srv);
  try {
    let s = await dark.fetchNow(); assert.equal(s.job.state, 'error'); assert.match(s.job.msg, /too dark image \(brightness 12 of 255\)/); assert.deepEqual(jpgs(dark.data), []);
    assert.equal(s.darkTool, true);
    await dark.py('dark', 'off'); s = await dark.fetchNow(); assert.equal(s.job.state, 'done', 'turned off: the dark image is accepted');
    s = await bright.fetchNow(); assert.equal(s.job.state, 'done'); assert.equal(s.images[0].m.luminance, 120);
    // the system may have a real tool; hide it by giving the run an empty tool path
    const r = await none.py('list', undefined, { PATH: none.bin + path.delimiter + '/nonexistent' });
    assert.equal(r.json.darkTool, false);
  } finally { await srv.close(); dark.done(); bright.done(); none.done(); }
});

test('rotation: favorites are never rotated out, the newest 30 others are kept', async () => {
  const srv = await fakeSources(); const w = setup(srv);
  try {
    fs.mkdirSync(w.data, { recursive: true });
    const names = [];
    for (let k = 0; k < 40; k++) { // 40 old images, k=0 the oldest; two of the oldest are favorites
      const n = `picsum-${k}-${1700000000 + k}.jpg`; names.push(n);
      fs.writeFileSync(path.join(w.data, n), jpeg()); fs.writeFileSync(path.join(w.data, n.replace('.jpg', '.json')), '{"source":"picsum"}');
      fs.utimesSync(path.join(w.data, n), 1700000000 + k, 1700000000 + k);
    }
    for (const n of [names[0], names[1]]) assert.equal((await w.py('fav', n)).code, 0);
    let s = await w.fetchNow(); assert.equal(s.job.state, 'done');
    const have = s.images.map((i) => i.n);
    assert.equal(have.filter((n) => !s.images.find((i) => i.n === n).fav).length, 30);
    assert.ok(have.includes(names[0]) && have.includes(names[1]), 'old favorites survive');
    assert.ok(!have.includes(names[2]), 'old non-favorites are rotated out');
    assert.ok(!fs.existsSync(path.join(w.data, names[2].replace('.jpg', '.json'))), 'with their sidecars');
    assert.equal(s.images.filter((i) => i.fav).length, 2);
    // unstar: toggles back
    s = (await w.py('fav', names[0])).json; assert.equal(s.images.find((i) => i.n === names[0]).fav, false);
  } finally { await srv.close(); w.done(); }
});

test('pick, fav and del check the name; del removes image, sidecar and star', async () => {
  const srv = await fakeSources(); const w = setup(srv);
  try {
    const s = await w.fetchNow(); const n = s.images[0].n;
    for (const bad of ['nope.jpg', '../x.jpg', 'secret.txt', '']) for (const c of ['pick', 'fav', 'del']) assert.notEqual((await w.py(c, bad)).code, 0, `${c} ${bad}`);
    const before = w.hatchLog().length;
    assert.equal((await w.py('pick', n)).code, 0); assert.equal(w.hatchLog().length, before + 1);
    assert.equal((await w.py('pick', 'nope.jpg')).code, 1); assert.equal(w.hatchLog().length, before + 1, 'a refused pick leaves the background alone');
    await w.py('fav', n);
    const r = await w.py('del', n); assert.deepEqual(r.json.images, []); assert.equal(r.json.current, '');
    assert.deepEqual(fs.readdirSync(w.data).filter((f) => /^picsum|\.json$/.test(f) && f !== 'settings.json' && f !== 'job.json'), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.data, 'settings.json'), 'utf8')).favorites, []);
  } finally { await srv.close(); w.done(); }
});

test('missing hatch command: the image is saved and the message says what to do', async () => {
  const srv = await fakeSources(); const w = setup(srv);
  try {
    fs.rmSync(path.join(w.bin, 'hatch'));
    const hide = '/nonexistent'; // keep python reachable through its absolute path, hide hatch
    const py = (await run('which', ['python3'])).stdout.trim();
    const r = await run(py, [path.join(w.dir, 'wallpaper.py'), w.state, 'fetch'], { env: { ...process.env, ...srv.env, PATH: hide } });
    assert.ok(r.stdout);
    let job; for (let i = 0; i < 60; i++) { job = JSON.parse(fs.readFileSync(path.join(w.data, 'job.json'), 'utf8')); if (job.state !== 'running') break; await new Promise((x) => setTimeout(x, 100)); }
    assert.equal(job.state, 'error'); assert.match(job.msg, /saved picsum-42-\d+\.jpg but the hatch command is not on the server PATH/);
    assert.equal(jpgs(w.data).length, 1);
  } finally { await srv.close(); w.done(); }
});

test('auto timer: persisted, validated, starts a download when due and not before', async () => {
  const srv = await fakeSources(); const w = setup(srv);
  try {
    assert.notEqual((await w.py('auto', '7')).code, 0);
    let s = (await w.py('auto', '30')).json; assert.equal(s.auto, 30); assert.ok(s.next > s.now + 1700);
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.data, 'settings.json'), 'utf8')).auto, 30, 'saved in settings.json');
    s = (await w.py('list')).json; assert.equal(s.job.state, undefined, 'not due yet: nothing started');
    const f = path.join(w.data, 'settings.json'); const set = JSON.parse(fs.readFileSync(f, 'utf8')); set.next = 1; fs.writeFileSync(f, JSON.stringify(set)); // due
    s = (await w.py('list')).json; assert.equal(s.job.state, 'running'); assert.equal(s.job.reason, 'auto'); assert.ok(s.next > s.now + 1700, 'next slot claimed');
    for (let i = 0; i < 60 && (await w.py('list')).json.job.state === 'running'; i++) await new Promise((x) => setTimeout(x, 100));
    assert.equal(jpgs(w.data).length, 1);
    s = (await w.py('auto', '0')).json; assert.equal(s.auto, 0);
  } finally { await srv.close(); w.done(); }
});

test('a job whose process died does not stay running', async () => {
  const w = setup(null);
  try {
    fs.mkdirSync(w.data, { recursive: true }); fs.writeFileSync(path.join(w.data, 'job.json'), JSON.stringify({ state: 'running', pid: 2 ** 22 - 3, started: Math.floor(Date.now() / 1000) }));
    const s = (await w.py('list')).json; assert.equal(s.job.state, 'error'); assert.match(s.job.msg, /interrupted/);
    fs.writeFileSync(path.join(w.data, '.tmp-1-x'), 'partial'); fs.utimesSync(path.join(w.data, '.tmp-1-x'), 1, 1);
    await w.py('list'); assert.ok(!fs.existsSync(path.join(w.data, '.tmp-1-x')), 'old partial files are swept');
  } finally { w.done(); }
});

test('through the server: shipped widget opens, state/fetch/del run as exec sources with the server state dir', async () => {
  const srv = await fakeSources(); const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-wpb-'));
  fs.writeFileSync(path.join(bin, 'hatch'), '#!/bin/sh\necho "$@" >> "$(dirname "$0")/hatch.log"\n', { mode: 0o755 });
  const saved = { ...process.env }; Object.assign(process.env, srv.env, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  const h = await startHatch();
  try {
    assert.equal((await h.call('POST', '/api/examples/wallpaper-shuffle/open', {})).status, 200);
    const call = (source, arg) => h.call('POST', '/api/call', { widget: 'wallpaper-shuffle', source, ...(arg !== undefined && { arg }) });
    let r = await call('state'); assert.equal(r.data.value.error, undefined, r.data.value.error); assert.deepEqual(r.data.value.json.images, []);
    r = await call('fetch'); assert.equal(r.data.value.json.job.state, 'running', 'fetch returns at once with the job running');
    let s; for (let i = 0; i < 80; i++) { s = (await call('state')).data.value.json; if (s.job.state !== 'running') break; await new Promise((x) => setTimeout(x, 100)); }
    assert.equal(s.job.state, 'done', s.job.msg);
    const log = fs.readFileSync(path.join(bin, 'hatch.log'), 'utf8');
    assert.ok(log.includes(`--state ${h.stateDir}`), 'hatch set background is told the server state dir'); assert.ok(log.startsWith('set background '));
    r = await call('del', s.images[0].n); assert.deepEqual(r.data.value.json.images, []);
    assert.notEqual((await call('del', 'nope.jpg')).data.value.code, 0);
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); await h.close(); await srv.close(); fs.rmSync(bin, { recursive: true, force: true }); }
});
