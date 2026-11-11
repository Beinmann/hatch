// Rain on a window pane. The canvas stays transparent where nothing is drawn, so the page and the terminal's translucent tint show through.
// Main path: WebGL (no libraries). The glass is simulated in plain JS (rain-sim.js), drawn into a small "water map" (rain-raster.js), and a
// fragment shader (rain-shader.js) refracts the page background through every drop. Only the background is refracted: the effect canvas
// sits under the terminal text, so text stays sharp. Fallback when WebGL is missing: the same simulation drawn as 2D shapes (no refraction).
// Effect interface (public/fx.js drives it): start(canvas, { animate, intensity }), setIntensity(n), stop(), resize(). One instance per page.
import { createGlass } from './rain-sim.js';
import { rasterStatic, rasterLive, runnerBox } from './rain-raster.js';
import { rainLevel, bgTransform, parseCssColor } from './rain-physics.js';
import { VERT, FRAG } from './rain-shader.js';

export const P = {
  FPS: 30,            // frame cap
  TYPING_FPS: 15,     // frame cap while keys are being typed: the shader pass over the whole pane competes with the terminal's own redraw, so typing stays smooth
  TYPING_HOLD: 0.4,   // seconds after the last keystroke that the lower cap stays
  STATIC_EVERY: 0.5,  // seconds one sweep over the resting drops takes: they are redrawn a band of rows per frame, so no frame pays for the whole pane
                      // (the running drop is redrawn every frame, only in its own small box)
  STYLE_EVERY: 1,     // seconds between looks at the page's background and tint (they can change while the effect runs)
  RAIN: 0.075,         // strength of the faint background rain (streak shape: STREAKS in rain-physics.js)
};
let level = rainLevel(50);
let cv = null, gl = null, ctx = null, raf = 0, last = 0, W = 1, H = 1, glass = null, animate = true, time = 0;
let buf = null, base = null, sinceStyle = 99, lost = false, bandY = 0, lastRunner = null, prevBox = null, needFull = true, scratch = null, typingUntil = 0;
let gp = null, mapTex = null, bgTex = null, bgUrl = '', bgImg = null, style = null;

const cssVar = (el, name) => getComputedStyle(el).getPropertyValue(name);

// ---- what is behind the glass: background image (+ its mode), body colour, terminal tint ----
function readStyle() {
  const root = document.documentElement, hasBg = root.classList.contains('has-bg');
  const m = hasBg ? /url\(\s*["']?(.*?)["']?\s*\)/.exec(cssVar(root, '--bg-image')) : null;
  const rect = cv.getBoundingClientRect();
  style = {
    url: m ? m[1] : '', mode: root.dataset.bgmode || 'fill', rect,
    base: parseCssColor(getComputedStyle(document.body).backgroundColor, [0.08, 0.09, 0.11, 1]),
    tint: parseCssColor(cv.parentElement ? getComputedStyle(cv.parentElement).backgroundColor : '', [0.08, 0.09, 0.11, 0]),
  };
  if (style.url !== bgUrl) loadBg(style.url);
}
function loadBg(url) {
  bgUrl = url; bgImg = null;
  if (!url || !gl) return;
  const img = new Image();
  img.onload = () => { if (bgUrl !== url || !gl || lost) return; bgImg = img; uploadBg(); if (!animate) render(); };
  img.onerror = () => { if (bgUrl === url) bgImg = null; };
  img.src = url;
}
function uploadBg() {
  if (!gl || !bgImg) return;
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, bgTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bgImg);
}

// ---- WebGL ----
function compile(type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader did not compile');
  return s;
}
function texture(unit) {
  const t = gl.createTexture(); gl.activeTexture(unit); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
function initGl() {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'shader did not link');
  gl.useProgram(prog);
  const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one big triangle covers the canvas
  const loc = gl.getAttribLocation(prog, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gp = { prog, u: {} };
  for (const n of ['uMap', 'uBg', 'uRes', 'uBgX', 'uTint', 'uBase', 'uHasImg', 'uTile', 'uAlpha', 'uTime', 'uRain']) gp.u[n] = gl.getUniformLocation(prog, n);
  mapTex = texture(gl.TEXTURE0); bgTex = texture(gl.TEXTURE1);
  gl.uniform1i(gp.u.uMap, 0); gl.uniform1i(gp.u.uBg, 1);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
  allocMap(); if (bgImg) uploadBg();
}
function allocMap() {
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, mapTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
}
function render() {
  if (!gl || lost || !style) return;
  const u = gp.u, s = style, vw = globalThis.innerWidth || W, vh = globalThis.innerHeight || H;
  const bt = bgTransform(s.mode, bgImg?.naturalWidth, bgImg?.naturalHeight, vw, vh, s.rect.left, s.rect.top);
  gl.viewport(0, 0, W, H);
  gl.uniform2f(u.uRes, W, H); gl.uniform4f(u.uBgX, bt.sx, bt.sy, bt.ox, bt.oy);
  gl.uniform4f(u.uTint, s.tint[0], s.tint[1], s.tint[2], s.tint[3]); gl.uniform3f(u.uBase, s.base[0], s.base[1], s.base[2]);
  gl.uniform1f(u.uHasImg, bgImg ? 1 : 0); gl.uniform1f(u.uTile, s.mode === 'tile' ? 1 : 0);
  gl.uniform1f(u.uAlpha, level.alpha); gl.uniform1f(u.uTime, time); gl.uniform1f(u.uRain, P.RAIN * Math.min(1.5, level.alpha));
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
function upload(r) { // only the rectangle that changed goes to the GPU (the whole map is 3 MB at 1200x700)
  const w = r.x1 - r.x0, h = r.y1 - r.y0; if (w <= 0 || h <= 0) return;
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, mapTex);
  let src;
  if (w === W) src = buf.subarray(r.y0 * W * 4, r.y1 * W * 4);
  else {
    if (!scratch || scratch.length < w * h * 4) scratch = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) scratch.set(buf.subarray(((r.y0 + y) * W + r.x0) * 4, ((r.y0 + y) * W + r.x1) * 4), y * w * 4);
    src = scratch.subarray(0, w * h * 4);
  }
  gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x0, r.y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, src);
}

// ---- 2D fallback: the same glass as plain shapes, no refraction ----
function draw2d() {
  ctx.globalAlpha = 1; ctx.clearRect(0, 0, W, H);
  const A = Math.min(1, level.alpha), TAU = Math.PI * 2;
  for (const t of glass.trails) for (let i = 1; i < t.pts.length; i++) {
    const a = t.pts[i - 1], b = t.pts[i], fa = glass.trailFade(a), fb = glass.trailFade(b), al = (fa.alpha + fb.alpha) / 2 * 0.2 * A; if (al < 0.004) continue;
    const wa = Math.max(0.3, a.w * fa.width) / 2, wb = Math.max(0.3, b.w * fb.width) / 2;
    ctx.fillStyle = `rgba(185,210,232,${al.toFixed(3)})`; ctx.beginPath(); ctx.moveTo(a.x - wa, a.y); ctx.lineTo(a.x + wa, a.y); ctx.lineTo(b.x + wb, b.y); ctx.lineTo(b.x - wb, b.y); ctx.closePath(); ctx.fill();
  }
  for (const d of glass.drops) {
    const look = glass.look(d), al = look.alpha * A; if (!(al > 0.01)) continue;
    const r = d.r * look.scale, rx = r * d.sx, ry = r * d.sy * (1 + d.tail * 0.5), cy = d.y - r * d.sy * d.tail * 0.5; if (!(rx > 0.2)) continue;
    ctx.globalAlpha = al;
    const g = ctx.createRadialGradient(d.x - rx * 0.15, cy - ry * 0.15, rx * 0.1, d.x, cy, Math.max(rx, ry));
    g.addColorStop(0, 'rgba(170,195,220,0.2)'); g.addColorStop(0.65, 'rgba(120,150,180,0.16)'); g.addColorStop(1, 'rgba(5,10,18,0.5)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(d.x, cy, rx, ry, 0, 0, TAU); ctx.fill();
    if (r > 1.6) {
      ctx.strokeStyle = 'rgba(200,222,240,0.3)'; ctx.lineWidth = Math.max(0.5, rx * 0.15); ctx.beginPath(); ctx.ellipse(d.x, cy + ry * 0.08, rx * 0.8, ry * 0.8, 0, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
      ctx.fillStyle = 'rgba(245,250,255,0.75)'; ctx.beginPath(); ctx.arc(d.x - rx * 0.38, cy - ry * 0.42, Math.max(0.5, rx * 0.2), 0, TAU); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// ---- common ----
const grow = (r, m) => ({ x0: Math.max(0, r.x0 - m), y0: Math.max(0, r.y0 - m), x1: Math.min(W, r.x1 + m), y1: Math.min(H, r.y1 + m) });
const union = (a, b) => (!a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
function fullRefresh() { // everything at once (start, resize, a new intensity, still frame)
  rasterStatic(base, W, H, glass); rasterLive(buf, base, W, H, glass); bandY = 0; needFull = false;
  lastRunner = glass.runner; prevBox = runnerBox(W, H, glass);
  if (gl && !lost) allocMap();
}
function refresh(dt) { // bring the water map up to date and draw: only changed parts are redrawn and uploaded
  if (!gl) { draw2d(); return; }
  if (needFull) fullRefresh();
  else {
    const rects = [];
    const redo = (c) => { rasterStatic(base, W, H, glass, c); rasterLive(buf, base, W, H, glass, c); rects.push(c); };
    if (glass.runner !== lastRunner) { // a run began or ended: the resting map must show (or stop showing) that drop and its trail
      if (lastRunner && prevBox) redo(grow(prevBox, 6));
      if (glass.runner) redo(runnerBox(W, H, glass));
      lastRunner = glass.runner;
    }
    const bandH = Math.max(8, Math.ceil(H * dt / P.STATIC_EVERY)), y1 = Math.min(H, bandY + bandH);
    redo({ x0: 0, y0: bandY, x1: W, y1 }); bandY = y1 >= H ? 0 : y1;
    const box = runnerBox(W, H, glass), live = union(prevBox, box);
    if (live) { rasterLive(buf, base, W, H, glass, live); rects.push(live); }
    prevBox = box;
    for (const r of rects) upload(r);
  }
  render();
}
function resize() {
  if (!cv) return;
  W = cv.width = Math.max(1, cv.clientWidth); H = cv.height = Math.max(1, cv.clientHeight);
  glass.resize(W, H); buf = new Uint8Array(W * H * 4); base = new Uint8Array(W * H * 4);
  if (gl) readStyle();
  needFull = true; if (!animate) settle();
}
function settle() { for (let i = 0; i < 240; i++) glass.step(0.25); needFull = true; refresh(0); } // reduced motion: one still frame of an already wet pane

function frame(t) {
  raf = requestAnimationFrame(frame);
  if (document.hidden || t - last < 1000 / (t < typingUntil ? P.TYPING_FPS : P.FPS)) return; // paused in a background tab; capped to keep the CPU and GPU cost low
  const dt = Math.min(0.1, (t - last) / 1000); last = t; time += dt; sinceStyle += dt;
  if (gl && sinceStyle >= P.STYLE_EVERY) { sinceStyle = 0; readStyle(); }
  glass.step(dt); refresh(dt);
}

const onKey = () => { typingUntil = performance.now() + P.TYPING_HOLD * 1000; };
const onLost = (e) => { e.preventDefault(); lost = true; };
const onRestored = () => { lost = false; try { initGl(); } catch (err) { console.warn(`rain: WebGL could not restart: ${err.message}`); } };

export default {
  name: 'rain',
  start(canvas, { animate: anim = true, intensity } = {}) {
    level = rainLevel(intensity); cv = canvas; animate = anim; lost = false; time = 0; gl = null; ctx = null; bgUrl = ''; bgImg = null;
    glass = createGlass({ W: 1, H: 1, count: level.count });
    // the canvas is fresh for every effect start (public/fx.js), so asking for webgl here cannot clash with another effect's 2d context
    try { gl = cv.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false }) || cv.getContext('experimental-webgl'); } catch { gl = null; }
    if (gl) {
      try { buf = new Uint8Array(4); initGl(); cv.addEventListener?.('webglcontextlost', onLost); cv.addEventListener?.('webglcontextrestored', onRestored); }
      catch (e) { console.warn(`rain: WebGL setup failed (${e.message}); no effect`); gl = null; cv = null; return; } // the canvas now belongs to webgl, so 2d is not available
    } else ctx = cv.getContext('2d');
    resize();
    if (!animate) return; // resize() already drew the still frame
    typingUntil = 0; document.addEventListener?.('keydown', onKey, true); // capture: seen even when the terminal stops the event
    last = performance.now(); raf = requestAnimationFrame(frame);
  },
  setIntensity(n) { level = rainLevel(n); if (glass) { glass.setCount(level.count); if (cv) { needFull = true; if (!raf) settle(); } } }, // the pane starts over, which is fine for a setting change
  stop() {
    cancelAnimationFrame(raf); raf = 0; document.removeEventListener?.('keydown', onKey, true);
    cv?.removeEventListener?.('webglcontextlost', onLost); cv?.removeEventListener?.('webglcontextrestored', onRestored);
    try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* already gone */ }
    cv = gl = ctx = glass = buf = base = bgImg = style = scratch = lastRunner = prevBox = null; needFull = true; bgUrl = ''; gp = mapTex = bgTex = null;
  },
  resize() { resize(); },
};
