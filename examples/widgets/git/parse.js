// Pure helpers for the git widget (no DOM), loaded by index.html and by the tests. Parses the marker-separated text
// that the source command in widget.json prints: @@home, @@top, @@status (porcelain v2), @@log (unit-separated fields).
(function (root) {
  const US = '\x1f';
  const LETTER = { M: 'M', T: 'M', A: 'A', D: 'D', R: 'R', C: 'R', U: 'U' };

  /** Splits `line` at the first `n` spaces; the rest (a path that may contain spaces) stays whole. */
  function fields(line, n) {
    const out = []; let from = 0;
    for (let i = 0; i < n; i++) { const j = line.indexOf(' ', from); if (j < 0) break; out.push(line.slice(from, j)); from = j + 1; }
    out.push(line.slice(from)); return out;
  }

  function parseRefs(text) {
    return String(text || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      if (s.startsWith('HEAD -> ')) return { name: s.slice(8), kind: 'head' };
      if (s === 'HEAD') return { name: 'HEAD', kind: 'head' };
      if (s.startsWith('tag: ')) return { name: s.slice(5), kind: 'tag' };
      return { name: s, kind: s.includes('/') ? 'remote' : 'branch' };
    });
  }

  function parseStatus(lines, st) {
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('@@more ')) { st.more = Number(line.slice(7)) || 0; continue; }
      if (line.startsWith('# ')) {
        const [k, ...v] = line.slice(2).split(' '); const val = v.join(' ');
        if (k === 'branch.head') st.branch.head = val;
        else if (k === 'branch.oid') st.branch.oid = val;
        else if (k === 'branch.upstream') st.branch.upstream = val;
        else if (k === 'branch.ab') { const m = /^\+(\d+) -(\d+)$/.exec(val); if (m) { st.branch.ahead = Number(m[1]); st.branch.behind = Number(m[2]); } }
        continue;
      }
      const t = line[0];
      if (t === '?') { st.untracked.push({ code: '??', path: line.slice(2) }); continue; }
      if (t === '!') continue;
      if (t === '1' || t === '2' || t === 'u') {
        const f = fields(line, t === '1' ? 8 : t === '2' ? 9 : 10);
        const xy = f[1] || '..'; let p = f[f.length - 1]; let from = null;
        if (t === '2') { const [a, b] = p.split('\t'); p = a; from = b || null; }
        if (t === 'u') { st.conflicts.push({ code: xy, path: p }); continue; }
        if (xy[0] !== '.') st.staged.push({ code: LETTER[xy[0]] || xy[0], path: p, from });
        if (xy[1] !== '.') st.unstaged.push({ code: LETTER[xy[1]] || xy[1], path: p, from });
      }
    }
  }

  /** text: the source output. Returns { state: 'ok' | 'norepo' | 'nodir', ... } */
  function parse(text) {
    const secs = { head: [], status: [], log: [] }; let cur = 'head';
    const st = { state: 'ok', home: '', top: '', branch: { head: '', oid: '', upstream: '', ahead: 0, behind: 0 }, conflicts: [], unstaged: [], staged: [], untracked: [], more: 0, commits: [] };
    for (const line of String(text || '').split('\n')) {
      if (line === '@@nodir') { st.state = 'nodir'; continue; }
      if (line === '@@norepo') { st.state = 'norepo'; continue; }
      if (line.startsWith('@@home ')) { st.home = line.slice(7); continue; }
      if (line.startsWith('@@top ')) { st.top = line.slice(6); continue; }
      if (line === '@@status') { cur = 'status'; continue; }
      if (line === '@@log') { cur = 'log'; continue; }
      if (cur !== 'head') secs[cur].push(line);
    }
    parseStatus(secs.status, st);
    for (const line of secs.log) {
      const p = line.split(US); if (p.length < 4) continue;
      st.commits.push({ hash: p[0], subject: p[1], ts: Number(p[2]) || 0, author: p[3], refs: parseRefs(p[4]) });
    }
    return st;
  }

  /** Home replaced by ~, then the middle replaced by an ellipsis when longer than `max` characters. */
  function shortPath(p, home, max = 40) {
    let s = String(p || '');
    if (home && (s === home || s.startsWith(`${home}/`))) s = `~${s.slice(home.length)}`;
    if (s.length <= max) return s;
    const keep = max - 1; const tail = Math.ceil(keep * 0.6); const head = keep - tail;
    return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
  }

  function relTime(ts, now) {
    const s = Math.max(0, Math.round((now / 1000) - ts));
    if (s < 60) return 'now';
    const u = [[60, 'm'], [3600, 'h'], [86400, 'd'], [604800, 'w'], [2592000, 'mo'], [31536000, 'y']];
    let out = `${s}s`;
    for (let i = 0; i < u.length; i++) { if (s >= u[i][0]) out = `${Math.floor(s / u[i][0])}${u[i][1]}`; }
    return out;
  }

  const splitPath = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) }; };
  const baseName = (p) => String(p || '').replace(/\/+$/, '').split('/').pop() || '/';

  const api = { parse, parseRefs, shortPath, relTime, splitPath, baseName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.GitParse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
