// Pasted or dropped images land in uploads/N.ext. The type comes from the magic bytes, never from the header or the
// file name, because the path is typed into a terminal and read by Claude.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_BYTES = 25 * 1024 * 1024;

/** Returns 'png' | 'jpg' | 'gif' | 'webp' or null. */
export function sniff(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export class UploadError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

/** Saves the image as uploads/N.ext, N = highest existing number + 1 (the `wx` flag makes a race retry, not overwrite). */
export function saveUpload(dir, buf) {
  if (buf.length > MAX_BYTES) throw new UploadError(`image is larger than ${MAX_BYTES / 1024 / 1024} MB`, 413);
  const ext = sniff(buf);
  if (!ext) throw new UploadError('not a PNG, JPEG, GIF or WebP image (checked the file header)', 415);
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 20; attempt++) {
    let max = 0;
    for (const f of fs.readdirSync(dir)) { const m = /^(\d+)\.\w+$/.exec(f); if (m) max = Math.max(max, Number(m[1])); }
    const name = `${max + 1}.${ext}`;
    const file = path.join(dir, name);
    try { fs.writeFileSync(file, buf, { flag: 'wx' }); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    return { name, path: path.resolve(file), bytes: buf.length };
  }
  throw new UploadError('could not pick a free upload number', 500);
}
