// git window (Magit-lite): branch, changed files with a checkbox for "staged", click a file for its diff, commit box.
import { el, isViewOnly } from '../util.js';

const LABEL = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', '?': 'new', T: 'type' };
const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;

export default {
  create(panel, ctx) {
    if (isViewOnly()) return { el: el('div', { class: 'muted pad' }, 'Git status and actions are unavailable in view-only mode.'), update() {}, destroy() {} };
    const dir = () => panel.props.dir || ctx.cwd();
    const head = el('div', { class: 'cap', style: 'display:flex;gap:8px;align-items:center;padding:4px 8px;border-bottom:1px solid var(--line)' });
    const list = el('ul', { class: 'flist', style: 'flex:1;overflow:auto' });
    const msg = el('input', { type: 'text', placeholder: 'Commit message', 'aria-label': 'Commit message', style: 'flex:1;padding:4px 6px;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg)' });
    const err = el('div', { class: 'banner', hidden: true });
    const commitBtn = el('button', { type: 'button' }, 'Commit');
    const root = el('div', { style: 'display:flex;flex-direction:column;height:100%' }, err, head, list, el('div', { class: 'cap', style: 'display:flex;gap:6px;padding:6px 8px;border-top:1px solid var(--line)' }, msg, commitBtn));
    let refreshing = false; let mutating = false; let destroyed = false; let revision = 0; let refreshRequest = 0;
    let snapshot = null; let stageAll = null; const pendingDiffs = new Set();
    let top = null; // repository root from the last status: file paths are relative to it

    const controls = () => {
      root.setAttribute('aria-busy', String(refreshing || mutating));
      commitBtn.disabled = mutating || !snapshot?.files.some((f) => f.staged) || !msg.value.trim();
      if (stageAll) stageAll.disabled = mutating || !snapshot.files.some((f) => !f.staged || f.worktree);
      for (const checkbox of list.querySelectorAll('input')) checkbox.disabled = mutating;
    };
    const call = async (route, body) => {
      if (destroyed || mutating) return;
      const request = ++revision; mutating = true; controls();
      try {
        const s = await ctx.api('POST', `/api/git/${route}`, { dir: dir(), ...body });
        if (destroyed || request !== revision) return;
        err.hidden = true; paint(s); return s;
      } catch (e) { if (!destroyed && request === revision) { err.hidden = false; err.textContent = e.message; if (snapshot) paint(snapshot); } }
      finally { mutating = false; if (!destroyed) controls(); }
    };
    const showDiff = async (f) => {
      if (destroyed) return;
      const repo = top || dir(); const key = `${repo}\0${f.path}`;
      if (pendingDiffs.has(key)) return;
      pendingDiffs.add(key);
      const cached = f.staged && !f.worktree; const cmd = `git --literal-pathspecs --no-pager diff --no-color ${cached ? '--cached ' : ''}-- ${q(f.path)}`;
      try {
        const r = await ctx.api('POST', '/api/runs', { cmd: f.untracked ? `cat -- ${q(`./${f.path}`)}` : cmd, cwd: repo });
        if (destroyed) return;
        await ctx.api('POST', '/api/panels', { type: 'output', title: `diff ${f.path}`.slice(0, 40), props: { cmd: `git diff ${f.path}`, runId: r.id, cwd: repo, kind: f.untracked ? undefined : 'diff', rerun: f.untracked ? `cat -- ${q(`./${f.path}`)}` : cmd }, w: 640, h: 340 });
      } catch (e) { if (!destroyed) ctx.toast(e.message, 'bad'); }
      finally { pendingDiffs.delete(key); }
    };
    function paint(s) {
      snapshot = s; top = s.root;
      stageAll = el('button', { type: 'button', title: 'Stage every change', onclick: () => call('stage', { paths: s.files.filter((f) => !f.staged || f.worktree).map((f) => f.path) }) }, 'Stage all');
      head.replaceChildren(el('strong', {}, s.branch), el('span', { class: 'muted small', style: 'flex:1' }, s.tracking || ''),
        stageAll);
      list.replaceChildren(...(s.files.length ? s.files.map((f) => el('li', { title: f.path, onclick: () => showDiff(f) },
        el('input', { type: 'checkbox', title: f.staged && !f.worktree ? 'Staged: untick to unstage' : 'Tick to stage', checked: f.staged && !f.worktree, onclick: (e) => e.stopPropagation(), onchange: (e) => call(e.target.checked ? 'stage' : 'unstage', { paths: [f.path] }) }),
        el('span', {}, f.path), el('span', { class: 'muted small' }, f.untracked ? 'new' : LABEL[f.worktree || f.index] || f.worktree || f.index))) : [el('li', { class: 'muted' }, 'Working tree clean')]));
      controls();
    }
    async function refresh(force = false) {
      if (destroyed || (!force && (refreshing || mutating || !root.offsetParent))) return;
      const request = ++revision; refreshRequest = request; refreshing = true; controls();
      try {
        const s = await ctx.api('GET', `/api/git/status?dir=${encodeURIComponent(dir())}`);
        if (!destroyed && request === revision) { err.hidden = true; paint(s); }
      } catch (e) { if (!destroyed && request === revision) { err.hidden = false; err.textContent = e.message; if (!snapshot) head.textContent = 'Git status unavailable'; } }
      finally { if (refreshRequest === request) refreshing = false; if (!destroyed) controls(); }
    }
    commitBtn.addEventListener('click', async () => {
      const message = msg.value; const s = await call('commit', { message });
      if (s && !destroyed) { if (msg.value === message) msg.value = ''; controls(); ctx.toast('Committed'); }
    });
    msg.addEventListener('input', controls);
    msg.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') commitBtn.click(); });
    head.textContent = 'Loading git status…'; controls();
    const timer = setInterval(() => refresh(), 4000); refresh(true);
    return { el: root, update(p) { const previous = dir(); panel = p; if (dir() !== previous) { snapshot = null; top = null; stageAll = null; list.replaceChildren(); head.textContent = 'Loading git status…'; refresh(true); } }, destroy() { destroyed = true; revision++; clearInterval(timer); } };
  },
};
