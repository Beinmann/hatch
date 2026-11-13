// Files widget model: pure functions, no DOM. Loaded as a classic script in the widget (window.FilesModel) and by node tests.
// Everything here only reads and formats what the read-only `ls` and `peek` sources print; nothing writes.
(function (root) {
  const LIST_LIMIT = 3000;          // the ls source prints at most this many entries + 1 (to detect "more")
  const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
  const SEP = '\x1f';

  /** Paths go to the server as data; it refuses control characters and anything over 4000 characters. */
  const pathOk = (p) => typeof p === 'string' && p.startsWith('/') && p.length <= 4000 && !/[\x00-\x08\x0a-\x1f\x7f]/.test(p);

  function parentOf(p) {
    if (typeof p !== 'string') return '/';
    const t = p.replace(/\/+$/, '');
    const i = t.lastIndexOf('/');
    return i <= 0 ? '/' : t.slice(0, i);
  }
  const joinPath = (dir, name) => (dir === '/' ? '' : dir.replace(/\/+$/, '')) + '/' + name;
  const baseName = (p) => { const t = String(p).replace(/\/+$/, ''); return t.slice(t.lastIndexOf('/') + 1) || '/'; };
  const extOf = (name) => { const i = String(name).lastIndexOf('.'); return i <= 0 ? '' : name.slice(i + 1).toLowerCase(); };
  const imageMime = (name) => IMAGE_MIME[extOf(name)] || null;

  /** ls output: "@@err message", or "@@real PATH", "@@entries" and NUL-separated records `ty<US>size<US>mtime<US>link<US>name`. */
  function parseLs(out) {
    const text = String(out || '');
    const err = /^@@err (.*)$/m.exec(text);
    if (err) return { state: 'err', error: err[1] };
    const real = /^@@real (.*)$/m.exec(text);
    const at = text.indexOf('@@entries'); // the server trims output, so an empty folder has no newline after it
    if (!real || at < 0) return { state: 'err', error: 'unexpected answer from the server; try reloading the widget' };
    const entries = [];
    let truncated = false;
    for (const rec of text.slice(at + 9).replace(/^\n/, '').split('\0')) {
      if (!rec) continue;
      if (entries.length >= LIST_LIMIT) { truncated = true; break; }
      const f = rec.split(SEP);
      if (f.length < 5) continue;
      const [ty, size, mtime, link] = f; const name = f.slice(4).join(SEP);
      const t = ty[0], target = ty[1] || ty[0];
      entries.push({ name, type: t === 'd' ? 'd' : t === 'l' ? 'l' : t === 'f' ? 'f' : 'o', isDir: t === 'd' || (t === 'l' && target === 'd'), broken: t === 'l' && (target === 'N' || target === 'L' || target === '?'), size: Number(size) || 0, mtime: Number(mtime) || 0, link: link || '' });
    }
    return { state: 'ok', real: real[1], entries, truncated };
  }

  /** Folders first, then names, case-insensitive with numbers in order (file2 before file10). */
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  function sortEntries(entries) {
    return entries.slice().sort((a, b) => (a.isDir === b.isDir ? collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.isDir ? -1 : 1));
  }
  const visible = (entries, showHidden) => (showHidden ? entries : entries.filter((e) => !e.name.startsWith('.')));
  /** What the list shows: sorted, hidden files only when asked for. */
  const listing = (entries, showHidden) => sortEntries(visible(entries, showHidden));

  const clamp = (i, len) => (len <= 0 ? -1 : Math.min(len - 1, Math.max(0, i)));
  /** New selection after moving by `delta` rows (-1 means nothing, when the list is empty). */
  const move = (sel, delta, len) => clamp((sel < 0 ? 0 : sel) + delta, len);
  const indexOfName = (list, name) => { const i = list.findIndex((e) => e.name === name); return i; };

  function formatSize(n) {
    if (!Number.isFinite(n) || n < 0) return '?';
    if (n < 1024) return `${n} B`;
    const u = ['KB', 'MB', 'GB', 'TB']; let v = n / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
  }
  function formatTime(sec, now) {
    if (!sec) return '';
    const d = new Date(sec * 1000); const p = (n) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    return `${day} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** peek output: header lines (@@stat, @@desc, @@image MIME, @@text, @@binary, @@bigimage, @@special, @@trunc), then "@@body" and the content. */
  function parsePeek(out) {
    const text = String(out || '');
    const err = /^@@err (.*)$/m.exec(text);
    if (err) return { state: 'err', error: err[1] };
    const at = text.indexOf('\n@@body\n');
    const head = at >= 0 ? text.slice(0, at) : text; const body = at >= 0 ? text.slice(at + 8) : '';
    const st = /^@@stat (.*)$/m.exec(head);
    if (!st) return { state: 'err', error: 'unexpected answer from the server; try reloading the widget' };
    const [size, mtime, mode, ...ft] = st[1].split('\t');
    const r = { state: 'ok', size: Number(size) || 0, mtime: Number(mtime) || 0, mode: mode || '', fileType: ft.join(' '), desc: (/^@@desc (.*)$/m.exec(head) || [])[1] || '' };
    const img = /^@@image (\S+)$/m.exec(head);
    if (img) return { ...r, kind: 'image', mime: img[1], dataUrl: `data:${img[1]};base64,${body.trim()}` };
    if (/^@@bigimage$/m.test(head)) return { ...r, kind: 'bigimage' };
    if (/^@@special$/m.test(head)) return { ...r, kind: 'special' };
    if (/^@@binary$/m.test(head)) return { ...r, kind: 'binary' };
    if (/^@@text$/m.test(head)) return { ...r, kind: 'text', text: body, truncated: /^@@trunc$/m.test(head) };
    return { ...r, kind: 'binary' };
  }

  root.FilesModel = { LIST_LIMIT, pathOk, parentOf, joinPath, baseName, extOf, imageMime, parseLs, sortEntries, visible, listing, move, indexOfName, formatSize, formatTime, parsePeek };
})(typeof window !== 'undefined' ? window : globalThis);
