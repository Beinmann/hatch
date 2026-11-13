// Pixel size of an image file from its header (PNG, GIF, JPEG, WebP; no dependencies), and the window size that suits it.
import fs from 'node:fs';

/** { w, h } or null when the format is unknown or the header is cut off. */
export function imageDimensions(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const t = buf.toString('latin1', 12, 16);
    if (t === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (t === 'VP8L') { const b = buf.readUInt32LE(21); return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) }; }
    if (t === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** Reads just the header of a file; null on any problem (a missing file must never stop a window from opening). */
export function fileDimensions(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try { const b = Buffer.alloc(65536); const n = fs.readSync(fd, b, 0, b.length, 0); return imageDimensions(b.subarray(0, n)); } finally { fs.closeSync(fd); }
  } catch { return null; }
}

const BASE_W = 640; const PULL = 0.25; const CHROME = 70; // title bar and caption row
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Window size for an image: a larger default than other windows, pulled (not scaled 1:1) toward the image size, same aspect. */
export function windowSizeFor({ w, h }) {
  if (!(w > 0 && h > 0)) return null;
  let ww = clamp(BASE_W + (w - BASE_W) * PULL, 480, 1000);
  let hh = ww * (h / w) + CHROME;
  if (hh > 760) { hh = 760; ww = Math.max(360, (760 - CHROME) * (w / h)); } // tall image: limit the height, keep the aspect
  return { w: Math.round(ww), h: Math.round(Math.max(hh, 320)) };
}
