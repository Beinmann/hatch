import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHatch, readSse, waitFor, PNG } from './helpers.js';

const UI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
const ui = (args, state) => new Promise((resolve) => {
  const p = spawn('node', [UI, '--state', state, ...args], { env: { ...process.env, HATCH_STATE: '' } });
  let stdout = ''; let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => resolve({ status, stdout, stderr }));
});
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const snap = async (h) => JSON.parse((await readSse(`${h.base}/api/events`, { 'x-token': h.hatch.token }, (e) => e.length > 0))[0].data);

test('set background copies the image, serves it and announces it', async () => {
  const h = await startHatch();
  try {
    const src = path.join(h.dir, 'pic.png'); fs.writeFileSync(src, PNG);
    const events = readSse(`${h.base}/api/events`, { 'x-token': h.hatch.token }, (e) => e.some((x) => x.event === 'background'), 5000);
    await new Promise((r) => setTimeout(r, 200));
    const r = await ui(['set', 'background', src], h.stateDir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(h.stateDir, 'background.png')));
    const ev = (await events).find((x) => x.event === 'background');
    assert.match(JSON.parse(ev.data).background.url, /^\/background\/image\?v=\d+$/);
    const res = await fetch(`${h.base}/background/image`, { headers: { 'x-token': h.hatch.token } });
    assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match((await snap(h)).background.url, /background\/image/);
    // a different format replaces the old file
    const jpg = path.join(h.dir, 'pic.jpg'); fs.writeFileSync(jpg, JPG);
    assert.equal((await ui(['set', 'background', jpg], h.stateDir)).status, 0);
    assert.deepEqual(fs.readdirSync(h.stateDir).filter((f) => f.startsWith('background')), ['background.jpg']);
  } finally { await h.close(); }
});

test('set background rejects bad input and keeps the current background', async () => {
  const h = await startHatch();
  try {
    const good = path.join(h.dir, 'a.png'); fs.writeFileSync(good, PNG);
    assert.equal((await ui(['set', 'background', good], h.stateDir)).status, 0);
    const txt = path.join(h.dir, 'a.txt'); fs.writeFileSync(txt, 'hello');
    let r = await ui(['set', 'background', txt], h.stateDir);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /not a PNG, JPEG, GIF or WebP.*unchanged/);
    r = await ui(['set', 'background', path.join(h.dir, 'missing.png')], h.stateDir);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /no such file/);
    r = await ui(['set', 'background', h.dir], h.stateDir);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /not a regular file/);
    r = await ui(['set', 'background'], h.stateDir); assert.notEqual(r.status, 0); assert.match(r.stderr, /usage/);
    assert.deepEqual(fs.readFileSync(path.join(h.stateDir, 'background.png')), PNG);
  } finally { await h.close(); }
});

test('background survives a restart; hand edits are picked up, bad files warn', async () => {
  const h = await startHatch();
  const bg = path.join(h.stateDir, 'background.png');
  try {
    fs.writeFileSync(bg, PNG);
    await waitFor(async () => (await snap(h)).background, 5000);
    // broken file: warning, no background, no crash
    fs.writeFileSync(bg, 'not an image');
    await waitFor(async () => { const s = await snap(h); return !s.background && s.warnings.some((w) => w.file === 'background'); }, 5000);
    assert.equal((await h.call('GET', '/background/image')).status, 404);
    // deleted: back to none and warning cleared
    fs.rmSync(bg);
    await waitFor(async () => { const s = await snap(h); return !s.background && !s.warnings.some((w) => w.file === 'background'); }, 5000);
    fs.writeFileSync(bg, PNG);
    await waitFor(async () => (await snap(h)).background, 5000);
  } finally { await h.close(); }
  // a new server on the same state dir shows it right away
  const { createHatch } = await import('../src/server.js');
  const h2 = createHatch({ stateDir: h.stateDir, host: '127.0.0.1', port: 0, attach: ['cat'], cwd: h.dir, pollState: true });
  const port = await h2.listen();
  try {
    const s = JSON.parse((await readSse(`http://127.0.0.1:${port}/api/events`, { 'x-token': h2.token }, (e) => e.length > 0))[0].data);
    assert.match(s.background.url, /background\/image/);
  } finally { await h2.close(); }
});

test('background mode: reading, validating, setting, and reaching the snapshot', async () => {
  const { readMode, setMode, clearBackground, MODES } = await import('../src/background.js');
  const dir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'bgmode-'));
  try {
    assert.deepEqual(readMode(dir), { mode: 'fill' }); // missing file: default, no warning
    for (const m of MODES) { setMode(dir, m); assert.deepEqual(readMode(dir), { mode: m }); }
    for (const bad of ['{broken', '{"mode":"zoom"}', '{"mode":7}', 'null', '[]']) {
      fs.writeFileSync(path.join(dir, 'background.json'), bad);
      const r = readMode(dir); assert.equal(r.mode, 'fill'); assert.match(r.problem, /background\.json/);
    }
    fs.writeFileSync(path.join(dir, 'background.json'), '{}'); assert.deepEqual(readMode(dir), { mode: 'fill' });
    assert.throws(() => setMode(dir, 'zoom'), /unknown mode.*fill, fit, stretch, center, tile/);
    fs.writeFileSync(path.join(dir, 'background.png'), PNG);
    assert.equal(clearBackground(dir), true); assert.equal(clearBackground(dir), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  const h = await startHatch();
  try {
    fs.writeFileSync(path.join(h.stateDir, 'background.png'), PNG);
    await waitFor(async () => (await snap(h)).background?.mode === 'fill', 5000);
    assert.equal((await ui(['set', 'background-mode', 'tile'], h.stateDir)).status, 0);
    await waitFor(async () => (await snap(h)).background?.mode === 'tile', 5000);
    const bad = await ui(['set', 'background-mode', 'zoom'], h.stateDir);
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /unknown mode/);
    fs.writeFileSync(path.join(h.stateDir, 'background.json'), '{"mode":"zoom"}');
    await waitFor(async () => { const s = await snap(h); return s.background?.mode === 'fill' && s.warnings.some((w) => w.file === 'background'); }, 5000);
    assert.equal((await ui(['set', 'background', 'none'], h.stateDir)).status, 0);
    await waitFor(async () => !(await snap(h)).background, 5000);
  } finally { await h.close(); }
});

test('transparency: set, reset, invalid input, bad saved file, reaching the snapshot', async () => {
  const h = await startHatch();
  const file = path.join(h.stateDir, 'transparency.json');
  try {
    assert.equal((await snap(h)).transparency, 30); // default with no file
    assert.equal((await ui(['set', 'transparency', '40'], h.stateDir)).status, 0);
    await waitFor(async () => (await snap(h)).transparency === 40, 5000);
    for (const bad of ['101', '-1', 'abc', '1.5']) {
      const r = await ui(['set', 'transparency', bad], h.stateDir);
      assert.notEqual(r.status, 0, bad); assert.match(r.stderr, /0 \(opaque\) to 100.*unchanged/);
    }
    assert.notEqual((await ui(['set', 'transparency'], h.stateDir)).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).percent, 40);
    fs.writeFileSync(file, '{"percent":250}');
    await waitFor(async () => { const s = await snap(h); return s.transparency === 30 && s.warnings.some((w) => w.file === 'transparency'); }, 5000);
    assert.equal((await ui(['set', 'transparency', '0'], h.stateDir)).status, 0);
    await waitFor(async () => { const s = await snap(h); return s.transparency === 0 && !s.warnings.some((w) => w.file === 'transparency'); }, 5000);
    fs.writeFileSync(file, '{broken');
    await waitFor(async () => (await snap(h)).warnings.some((w) => w.file === 'transparency'), 5000);
  } finally { await h.close(); }
});

test('window transparency: default for windows without their own setting, keeps and is kept by the page value', async () => {
  const h = await startHatch();
  const file = path.join(h.stateDir, 'transparency.json');
  try {
    assert.equal((await snap(h)).windowTransparency, null); // unset: windows follow the page
    assert.equal((await ui(['set', 'window-transparency', '0'], h.stateDir)).status, 0);
    await waitFor(async () => (await snap(h)).windowTransparency === 0, 5000);
    assert.equal((await ui(['set', 'transparency', '50'], h.stateDir)).status, 0); // page value change keeps the window default
    await waitFor(async () => (await snap(h)).transparency === 50, 5000);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { percent: 50, windows: 0 });
    for (const bad of ['101', '-1', 'abc', '']) {
      const r = await ui(['set', 'window-transparency', bad], h.stateDir);
      assert.notEqual(r.status, 0, bad); assert.match(r.stderr, /unchanged|usage/);
    }
    assert.equal((await ui(['set', 'window-transparency', 'default'], h.stateDir)).status, 0);
    await waitFor(async () => (await snap(h)).windowTransparency === null, 5000);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { percent: 50 });
    assert.equal((await h.call('PUT', '/api/transparency/windows', { percent: 25 })).status, 200);
    await waitFor(async () => (await snap(h)).windowTransparency === 25, 5000);
    fs.writeFileSync(file, '{"percent":10,"windows":250}');
    await waitFor(async () => { const s = await snap(h); return s.transparency === 10 && s.windowTransparency === null && s.warnings.some((w) => w.file === 'transparency'); }, 5000);
  } finally { await h.close(); }
});
