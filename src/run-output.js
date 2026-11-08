import { stripAnsi } from '../public/ansi.js';

export const KEEP_OUTPUT = 512 * 1024;

export function appendOutput(output, chunk, limit = KEEP_OUTPUT) {
  output.chunks.push(chunk); output.bytes += chunk.length;
  let trimmed = false;
  while (output.bytes > limit && output.chunks.length) {
    const first = output.chunks[0]; const excess = output.bytes - limit;
    if (first.length <= excess) { output.chunks.shift(); output.bytes -= first.length; }
    else { output.chunks[0] = Buffer.from(first.subarray(excess)); output.bytes -= excess; }
    trimmed = true;
  }
  if (!trimmed) return;
  output.truncated = true;
  // A partial UTF-8 prefix cannot be decoded by a newly attached viewer. Skip only continuation bytes.
  while (output.chunks.length) {
    const first = output.chunks[0]; let skip = 0;
    while (skip < first.length && (first[skip] & 0xc0) === 0x80) skip++;
    if (!skip) break;
    output.bytes -= skip;
    if (skip === first.length) output.chunks.shift();
    else { output.chunks[0] = Buffer.from(first.subarray(skip)); break; }
  }
}

export function retainedText(output) {
  // A running snapshot may end partway through a character; the next snapshot will contain the remaining bytes.
  return stripAnsi(new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.concat(output.chunks), { stream: output.state !== 'done' }));
}

export function outputTail(text, max = 65536) {
  if (!Number.isSafeInteger(max) || max < 1) throw Object.assign(new Error('max must be a positive integer number of characters'), { status: 400 });
  max = Math.min(max, 1048576);
  let start = text.length;
  while (start > 0 && max-- > 0) {
    const code = text.charCodeAt(--start);
    if (code >= 0xdc00 && code <= 0xdfff && start > 0) {
      const previous = text.charCodeAt(start - 1); if (previous >= 0xd800 && previous <= 0xdbff) start--;
    }
  }
  return start ? `...(truncated)...\n${text.slice(start)}` : text;
}
