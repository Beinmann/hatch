// Pure helpers for the git widget (no DOM), loaded by index.html and by the tests. Parses the marker-separated text
// that the source command in widget.json prints: @@home, @@top, @@status (porcelain v2), @@log and @@activity (unit-separated fields).
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

  /** Pills worth showing on a commit row: everything except the checked-out branch (the header already names it). */
  function rowRefs(refs, head) { return refs.filter((r) => !(r.kind === 'head' && r.name === head)); }

  /** Author initials are only informative when the listed commits have more than one author. */
  function multiAuthor(commits) { return new Set(commits.map((c) => c.author)).size > 1; }

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

  /** Reflog lines `ts US ref@{n} US message US hash` (all refs, newest first) -> at most `max` events.
   *  An event is recorded in HEAD's reflog and in its branch's reflog; keep one, preferring the branch name.
   *  Remote-tracking noise (fetch, push updates) is dropped. */
  function parseActivity(lines, max = 5) {
    const seen = new Map(); const out = [];
    for (const line of lines) {
      const p = line.split(US); if (p.length < 4) continue;
      const ref = p[1].replace(/@\{\d+\}$/, ''); const msg = p[2];
      if (msg === 'update by push' || msg.startsWith('fetch')) continue;
      const key = `${p[0]}\x1f${msg}\x1f${p[3]}`;
      const ev = { ts: Number(p[0]) || 0, ref, ...describe(ref, msg), hash: p[3] };
      const prev = seen.get(key);
      if (prev) { if (prev.ref === 'HEAD' && ref !== 'HEAD') { prev.ref = ref; prev.text = ev.text; prev.kind = ev.kind; } continue; }
      seen.set(key, ev); out.push(ev);
    }
    return out.slice(0, max);
  }

  /** Short human wording for a reflog message plus its kind (picks the icon); unknown kinds fall back to the raw message.
   *  Git removes a branch's reflog when the branch is deleted, so there is no "deleted branch" entry to recognise. */
  function describe(ref, msg) {
    const on = ref === 'HEAD' ? '' : ` on ${ref}`;
    const r = (kind, text) => ({ kind, text });
    let m;
    if (/^branch: Created from/.test(msg)) return r('branch', `created branch ${ref}`);
    if ((m = /^branch: Reset to (.*)$/.exec(msg))) return r('reset', `reset ${ref} to ${m[1]}`);
    if ((m = /^checkout: moving from (\S+) to (\S+)$/.exec(msg))) return r('checkout', `checkout ${m[1]} → ${m[2]}`);
    if ((m = /^commit \(initial\): (.*)$/.exec(msg))) return r('first', `first commit${on}: ${m[1]}`);
    if ((m = /^commit \(merge\): (.*)$/.exec(msg))) return r('mergecommit', `merge commit${on}: ${m[1]}`);
    if ((m = /^commit \(amend\): (.*)$/.exec(msg))) return r('amend', `amended${on}: ${m[1]}`);
    if ((m = /^commit: (.*)$/.exec(msg))) return r('commit', `commit${on}: ${m[1]}`);
    if ((m = /^merge (.*)$/.exec(msg))) return r('merge', `merge${on} ${m[1]}`);
    if (/^reset: /.test(msg)) return r('reset', `reset${on}`);
    if ((m = /^rebase.*?: (.*)$/.exec(msg))) return r('rebase', `rebase${on}: ${m[1]}`);
    if ((m = /^cherry-pick: (.*)$/.exec(msg))) return r('cherry', `cherry-pick${on}: ${m[1]}`);
    return r('other', `${ref === 'HEAD' ? '' : `${ref}: `}${msg}`);
  }

  /** text: the source output. Returns { state: 'ok' | 'norepo' | 'nodir', ... } */
  function parse(text) {
    const secs = { head: [], status: [], log: [], activity: [] }; let cur = 'head';
    const st = { state: 'ok', home: '', top: '', branch: { head: '', oid: '', upstream: '', ahead: 0, behind: 0 }, conflicts: [], unstaged: [], staged: [], untracked: [], more: 0, commits: [], activity: [] };
    for (const line of String(text || '').split('\n')) {
      if (line === '@@nodir') { st.state = 'nodir'; continue; }
      if (line === '@@norepo') { st.state = 'norepo'; continue; }
      if (line.startsWith('@@home ')) { st.home = line.slice(7); continue; }
      if (line.startsWith('@@top ')) { st.top = line.slice(6); continue; }
      if (line === '@@status') { cur = 'status'; continue; }
      if (line === '@@log') { cur = 'log'; continue; }
      if (line === '@@activity') { cur = 'activity'; continue; }
      if (cur !== 'head') secs[cur].push(line);
    }
    parseStatus(secs.status, st);
    for (const line of secs.log) {
      const p = line.split(US); if (p.length < 4) continue;
      st.commits.push({ hash: p[0], subject: p[1], ts: Number(p[2]) || 0, author: p[3], refs: parseRefs(p[4]) });
    }
    st.activity = parseActivity(secs.activity);
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

  // ---- inspect views: `git show` of a commit and the diff of one file ----

  /** Argument for the `diff` source: mode TAB ref TAB path TAB from (ref is "-" outside commit mode).
   *  Returns null for names the tab-separated form cannot carry (tab or control characters). */
  function diffArg(mode, ref, path, from) {
    const parts = [mode, ref || '-', path, from || ''];
    return parts.some((p) => /[\x00-\x1f\x7f]/.test(p)) || !path ? null : parts.join('\t');
  }

  /** `git diff` / `git show` patch text -> files [{path, from, status: M|A|D|R, binary, add, del, hunks:[{head, lines:[{t, s}]}]}].
   *  t is '+', '-', ' ' or '\\' (no newline marker). Tolerates a patch cut off in the middle and combined diffs of conflicts. */
  function parseDiff(text) {
    const files = []; let f = null; let h = null;
    for (const line of String(text || '').split('\n')) {
      if (/^diff --(git|cc|combined) /.test(line)) {
        const cc = !line.startsWith('diff --git ');
        f = { path: '', from: '', to: '', status: 'M', binary: false, add: 0, del: 0, hunks: [], cc }; h = null; files.push(f);
        const rest = line.slice(line.indexOf(' ', 7) + 1);
        if (cc) f.to = rest;
        else { const x = (rest.length - 5) / 2; if (Number.isInteger(x) && x > 0 && rest === `a/${rest.slice(2, 2 + x)} b/${rest.slice(2, 2 + x)}`) f.to = f.from = rest.slice(2, 2 + x); }
        continue;
      }
      if (!f) continue;
      if (h === null) {   // still in the header lines of this file
        let m;
        if (line.startsWith('new file mode')) { f.status = 'A'; f.from = ''; }
        else if (line.startsWith('deleted file mode')) f.status = 'D';
        else if ((m = /^(?:rename|copy) from (.*)$/.exec(line))) { f.status = 'R'; f.from = m[1]; }
        else if ((m = /^(?:rename|copy) to (.*)$/.exec(line))) { f.to = m[1]; }
        else if (/^Binary files |^GIT binary patch/.test(line)) f.binary = true;
        else if ((m = /^--- (?:a\/)?([^\t]*)/.exec(line))) { if (m[1] !== '/dev/null') f.from = m[1]; }   // git adds a tab after names with spaces
        else if ((m = /^\+\+\+ (?:b\/)?([^\t]*)/.exec(line))) { if (m[1] !== '/dev/null') f.to = m[1]; }
        else if (/^@@+ /.test(line)) { h = { head: line, lines: [] }; f.hunks.push(h); }
        continue;
      }
      if (/^@@+ /.test(line)) { h = { head: line, lines: [] }; f.hunks.push(h); continue; }
      const mark = f.cc ? line.slice(0, 2) : line[0];
      const t = mark === undefined || mark === '' ? ' ' : mark.includes('+') ? '+' : mark.includes('-') ? '-' : mark[0] === '\\' ? '\\' : ' ';
      if (t === '+') f.add++; else if (t === '-') f.del++;
      h.lines.push({ t, s: line.slice(f.cc ? 2 : 1) });
    }
    for (const x of files) { x.path = x.status === 'D' ? x.from || x.to : x.to || x.from; if (x.status !== 'R') x.from = ''; delete x.to; }
    return files;
  }

  /** `git show --numstat -z` text -> [{path, from, add, del, binary}] */
  function parseNumstat(text) {
    const t = String(text || '').split('\0'); const out = [];
    for (let i = 0; i < t.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(t[i].replace(/^\n/, '')); if (!m) continue;
      let path = m[3]; let from = '';
      if (path === '') { from = t[i + 1] || ''; path = t[i + 2] || ''; i += 2; }
      out.push({ path, from, add: m[1] === '-' ? 0 : Number(m[1]), del: m[2] === '-' ? 0 : Number(m[2]), binary: m[1] === '-' });
    }
    return out;
  }

  /** Output of the `show` source -> { state: 'ok'|'bad'|'nodir', hash, parents, author, ts, refs, subject, body, truncated, files }.
   *  files come from numstat (every file, in order) with the parsed patch attached as `diff` when it was not cut off. */
  function parseShow(text) {
    text = String(text || '');
    if (/^@@nodir/.test(text)) return { state: 'nodir' };
    if (!/^@@meta\n/.test(text)) return { state: 'bad' };
    const bi = text.indexOf('\n@@body\n');
    const head = bi < 0 ? text : text.slice(0, bi); const body = bi < 0 ? '' : text.slice(bi + 8);
    const secs = { meta: [], numstat: [], diff: [] }; let cur = 'meta'; let truncated = false;
    for (const line of head.split('\n')) {
      if (line === '@@meta' || line === '@@numstat' || line === '@@diff') { cur = line.slice(2); continue; }
      if (line === '@@trunc') { truncated = true; continue; }
      secs[cur].push(line);
    }
    const p = (secs.meta[0] || '').split(US);
    const [subject, ...rest] = body.replace(/\s+$/, '').split('\n');
    const patches = parseDiff(secs.diff.join('\n'));
    const files = parseNumstat(secs.numstat.join('\n')).map((n) => {
      const d = patches.find((x) => x.path === n.path) || null;
      return { ...n, status: d ? d.status : n.from ? 'R' : 'M', diff: d };
    });
    return { state: 'ok', hash: p[0] || '', parents: (p[1] || '').split(' ').filter(Boolean), author: p[2] || '', ts: Number(p[3]) || 0, refs: parseRefs(p[4]), subject: subject || '', body: rest.join('\n').replace(/^\n+/, ''), truncated, files };
  }

  /** Output of the `diff` source -> { state: 'ok'|'bad'|'nodir', truncated, list: [paths] | null, files }.
   *  `list` is set when the path was an untracked folder (git reports the folder, not what is in it). */
  function parseFileDiff(text) {
    text = String(text || '');
    if (/^@@nodir/.test(text)) return { state: 'nodir' };
    if (/^@@bad/.test(text)) return { state: 'bad' };
    const truncated = /^@@trunc\n/.test(text); text = text.replace(/^@@trunc\n/, '');
    if (/^@@list\n?/.test(text)) return { state: 'ok', truncated, list: text.replace(/^@@list\n?/, '').split('\n').filter(Boolean), files: [] };
    return { state: 'ok', truncated, list: null, files: parseDiff(text) };
  }

  /** Bar lengths for a stat listing, like `git diff --stat`: the busiest file gets `width` cells, others scale, nonzero parts get at least one. */
  function statBars(files, width = 20) {
    const max = Math.max(1, ...files.map((f) => f.add + f.del)); const k = max > width ? width / max : 1;
    return files.map((f) => ({ plus: f.add ? Math.max(1, Math.round(f.add * k)) : 0, minus: f.del ? Math.max(1, Math.round(f.del * k)) : 0 }));
  }

  const splitPath = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) }; };
  const baseName = (p) => String(p || '').replace(/\/+$/, '').split('/').pop() || '/';

  const api = { diffArg, parseDiff, parseNumstat, parseShow, parseFileDiff, statBars, rowRefs, multiAuthor, parse, parseActivity, parseRefs, shortPath, relTime, splitPath, baseName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.GitParse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
