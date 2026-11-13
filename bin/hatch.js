#!/usr/bin/env node
// hatch: the CLI Claude (or you) runs inside the tmux session to drive the page. Convenience only: every command
// just writes files in the state dir or calls the HTTP API; writing the files yourself works too (see README).
// Exit codes: 0 ok, 1 usage or validation, 2 cannot reach the server.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepSlug as slug } from '../src/progress.js';
import { firstCommandIndex, SERVER_COMMANDS } from '../src/cli-options.js';
import { COMMAND_HELP } from './ui-help.js';
import { CliError, chooseStateDir, resolveStateDir, makeClient, readConfig } from '../src/find.js';
import { doctor, printChecks } from '../src/doctor.js';
import { openTypeFor } from '../src/pages.js';
import { layout, NAME_RE, STEP_STATUS } from '../src/state.js';
import * as background from '../src/background.js';
import * as wsapi from '../src/workspaces.js';
import * as transparency from '../src/transparency.js';
import { setFx, readFx, FxError, EFFECTS } from '../src/fx.js';
import { parseEvery } from '../src/schedules.js';

// Server commands used to live under `hatch`. Forward them to `hatch-server` with a one-line notice so running setups,
// service files and old agent instructions keep working. (`hatch doctor` is also a page command and stays here.)
{
  const argv = process.argv.slice(2); const i = firstCommandIndex(argv);
  if (i >= 0 && SERVER_COMMANDS.has(argv[i])) {
    console.error(`hatch: \`hatch ${argv[i]}\` moved to \`hatch-server ${argv[i]}\`; the old form still works for now.`);
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('./hatch-server.js', import.meta.url)), ...argv], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
}

const EXAMPLES = fileURLToPath(new URL('../examples/widgets/', import.meta.url));

const HELP = `hatch: drive the Hatch page from the terminal (the server is run with \`hatch-server\`: serve, start, stop, restart, status, url, doctor, service)

agent integration
  agent show                       print persistent Hatch instructions
  agent init [--target claude|codex|both] [--dir DIR]   maintain a marked block in project instruction files
  convert NAME|ID --to TYPE         turn a window into another type, keeping title and position (note->progress|widget, progress->note, widget->note; diagram = progress)
progress
  progress set FILE|-               replace the Mermaid diagram (file or stdin)
  progress show                     print diagram and steps
  progress open                     open the progress window
  progress plans                    list the plans (several can run side by side, one window each)
  progress close --plan NAME        close a named plan (its window and file)
  --plan NAME (or export HATCH_PLAN=NAME) on any progress command picks a plan, creating it on first use; with
  several plans and no name the command fails and lists them. With 0 or 1 plans nothing changes.
  progress plan "STEP" "STEP" ...   replace the plan with ordered steps
  progress steps set FILE|-         replace steps.json
  progress step "TITLE|ID" STATUS [--detail TEXT] [--group NAME]
                                    STATUS: ${STEP_STATUS.join(' | ')}
widgets   (see \`hatch widget new --help\` for the postMessage SDK)
  widget new NAME [--from example]  scaffold widgets/NAME: from an example (cpu, log-tail, ...) or, without --from, a minimal one
  widget add NAME [DIR|FILE]        register and open (a single HTML file becomes index.html)
  (short forms: ha for hatch, w for widget: ha w open git; top-level open is for files, folders and URLs)
  widget list | open NAME | close NAME | rm NAME | reload NAME   (open git: the git window for the current directory's repository)
  widget examples                   list the example widgets (also in the palette)
  widget generate "DESCRIPTION" [--name N]   ask \`claude -p\` to write a widget from a description, then open it
                                    (alias: popup generate; set HATCH_CLAUDE to use another claude binary)
panels
  term NAME [--cmd CMD]             another terminal in a window (its own tmux session; --cmd runs a command first)
  files [DIR]                       file browser (open images and text files, download, drop to upload)
  edit FILE[:LINE]                  small text editor window (Ctrl+S saves); LINE puts the cursor there
  host list [--json] | stop ID | stop --all   list hosted pages; stop hosting one or all (their links then give 404; a file named list or stop: host ./list)
  host FILE.html [--yes] [--no-open]  open the page full size in a new tab of the Hatch browser UI and print its link (no secret in it; --no-open only prints). The page runs sandboxed; its folder is served read-only to browsers logged in to Hatch, so this warns and asks to confirm (--yes skips the question)
  serve-dir [DIR] [PORT]            serve a folder over HTTP (python3) and show it in a window, e.g. a generated HTML report
  image PATH [--title T]            show an image
  open FILE|DIR|URL [--title T] [--direct]   detect image, HTML page (.html/.htm: rendered in a sandboxed window; edit its source with: hatch edit FILE), text, directory or URL; http://localhost:PORT goes through Hatch's proxy to the box's own port
  note "markdown" [--title T]       small note panel
  panels                            list open panels
  close ID                          close a panel
schedules (run a command periodically, notify when pass/fail changes)
  every INTERVAL "CMD" [--name N] [--always] | schedules | unschedule NAME      INTERVAL: 30s, 5m, 2h (at least 10s)
bookmarks (named files and folders; the palette opens them)
  bookmark add NAME [PATH] | bookmark list | bookmark rm NAME      PATH defaults to the current directory
  trash [list] | trash restore [TRASH_ID] | trash empty    closed windows, short ids (restore without an id = the latest)
saved commands (typed into the terminal from the palette: leader key, then p)
  cmd add NAME TEXT [--no-enter] | cmd list | cmd rm NAME
  prompt add NAME TEXT|- | prompt list | prompt rm NAME      multi-line prompts pasted into the terminal (no Enter), e.g. for Claude Code
watches (notify when terminal output matches or goes quiet)
  watch add NAME --pattern REGEX [--level info|warn|done] [--cooldown SEC] | watch idle SECONDS [--name N]
  watch list | watch rm NAME
search and review (output windows with clickable path:line results)
  grep PATTERN [DIR]                search files (uses rg when installed, else grep -rn)
  diff [GIT-ARGS...]                coloured git diff (default: working tree)
  diff-files A B                    compare two files (unified diff, coloured), like Emacs ediff
  log [GIT-ARGS...]                 recent commits (default: last 30, one line each)
  man PAGE [SECTION]                a manual page in a window
  tail FILE                         follow a file in a window (Stop ends it)
  curl [CURL-ARGS...]               request in a window: status line, headers and body (curl must be installed)
run a command in its own live output window (Emacs compilation-mode idea)
  run "CMD" [--title T] [--wait]    --wait: block until it ends and exit with its code
  runs [--open ID]                  list this server's runs (kept in memory); --open shows one's output again
ask the user (blocks until they answer in the browser; prints the answer)
  ask "question" [CHOICE ...] [--text] [--timeout SEC]     default choices: Yes No; exit 3 on timeout
  set background IMAGE [--ws NAME]  use a PNG, JPEG, GIF or WebP image as the page background (saved in the state dir as background.EXT)
  set background none               remove the background image
  set transparency 0..100           make the terminal and panels see-through: 0 = opaque, 30 = default, 100 = fully transparent (saved in transparency.json)
  set window-transparency 0..100|default|follow    transparency of windows you did not set one by one (leader o); "default" = 0 (opaque, the built-in default), "follow" = same as the terminal/page transparency (saved in transparency.json). Above 80 is capped at 80
  set background-mode MODE          how it fits: fill (cover, default) | fit (contain) | stretch | center | tile (saved in background.json)
workspaces (named sets of windows with their own terminal and background, in this one instance)
  workspace list                    names, window counts, which have a background
  workspace new NAME                create an empty workspace (switch to it in the page: palette, "workspace: switch")
  workspace rename OLD NEW          windows, terminal and background stay with it
  workspace close NAME --confirm NAME   closes its windows and terminals for good; the name must be typed out
  workspace import STATE-DIR [NAME]     fold another instance's windows and background into a workspace (terminals start fresh)
  migrate [DIR] [--name NAME] [--dry-run] [--yes]   import a project's .hatch (DIR, or the nearest one above here) into this per-user instance as a workspace:
                                    windows, layout, background, terminal start directory, commands, widgets, schedules, bookmarks, custom css/js, settings.
                                    The source is never changed; existing settings win (conflicts are listed). Works with the server stopped (--state TARGET for another target)
  open a page directly in one with  http://HOST:PORT/#NAME
background effects (behind the terminal text, visible at any transparency)
  fx                                show the active effect, its intensity and the list
  fx list                           all effects, the active one marked with *
  fx NAME | off                     switch the effect (matrix rain goo snow starfield aurora fireflies embers waves; saved in fx.json; open pages update by themselves)
  fx [NAME] --intensity 0-100       how strong the effect is (default 50, kept per effect; no NAME = the active one)
desktop
  windows transparency 0..100       set the transparency of every window that is open right now (each kept per window, like leader o)
  desktop                           open a set of live gadgets (graph, system, clock, top, git, log) plus the progress panel
git (Magit-lite window)
  git [DIR]                         status window: stage with checkboxes, click a file for its diff, commit
discover
  tasks [--run NAME]                list package.json scripts and Makefile targets of the server dir; --run opens one in an output window
  ports                             listening TCP ports on the box (and which process owns them)
setup (move your Hatch customisation to another box; never includes the token, uploads or logs)
  export [FILE.tgz]                 saves commands, prompts, watches, schedules, bookmarks, custom.css/js and your widgets
  import FILE.tgz [--force]         restores them into this box's state dir (existing files are kept unless --force)
report
  report [--open] [--out FILE]      markdown summary of the session (progress, TODO, runs, windows); --open shows it as a note
clipboard (box -> your browser)
  copy "text" | copy -            put text (or stdin) on the clipboard of the browser; a Copy button appears if the browser needs a click
other
  notify "text" [--level info|warn|done]
  upload-dir                        where pasted images land
  doctor                            check tmux, python3, node, server
window options: --size WIDTHxHEIGHT, --full (or --fullscreen), --no-focus
options: --state DIR, --ws WORKSPACE (windows opened by this command go there; default $HATCH_WORKSPACE, set in each workspace's terminals, else main), --json (listings), --help`;

const WIDGET_HELP = `widget protocol (iframe sandbox, no network; data arrives by postMessage)

A widget is widgets/NAME/index.html plus an optional widget.json:
  { "title": "CPU", "w": 320, "h": 200, "placement": "float",
    "sources": [ { "name": "cpu", "kind": "metric", "id": "cpu", "everyMs": 1000 } ] }
Source kinds: metric (cpu mem load disk net), exec {cmd, json?, everyMs}, tail {path}, file {path}.
In index.html load the helper and subscribe:
  <script src="/sdk.js"></script>
  <script>hatch.on('cpu', (v) => { el.textContent = v.total + '%'; });</script>
hatch.on(source, fn) | hatch.off(source) | hatch.resize(w, h) | hatch.log(text) | hatch.theme (bg fg accent mono)
Editing any file in the widget directory reloads the widget in the page.`;

function parse(argv) {
  const o = { _: [] };
  const flags = new Set(['json', 'help', 'no-enter', 'text', 'direct', 'wait', 'open', 'always', 'force', 'full', 'fullscreen', 'no-focus', 'dry-run', 'yes', 'no-open', 'all']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o._.push(...argv.slice(i + 1)); break; }
    if (a === '-h') o.help = true;
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (flags.has(k)) o[k] = true;
      else { o[k] = v ?? argv[++i]; if (o[k] === undefined) throw new CliError(`--${k} needs a value`); }
    } else o._.push(a);
  }
  return o;
}

const readInput = (src) => (src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8'));
const need = (cond, msg) => { if (!cond) throw new CliError(msg); };
const checkName = (n) => need(NAME_RE.test(String(n)), `widget name must be letters, digits, - and _ (got ${JSON.stringify(n)})`);
/** `convert NAME --to TYPE`: NAME is a panel id, a widget name, a unique type or a title. */
async function convertWindow(api, o, name) {
  need(name, 'usage: convert NAME|ID --to note|widget|diagram');
  const list = await api('GET', '/api/panels');
  const exact = list.find((p) => p.id === name || p.id === `w-${name}`);
  const matches = exact ? [exact] : list.filter((p) => p.type === name || p.title === name);
  need(matches.length === 1, matches.length ? `more than one window matches ${name}; use its ID from hatch panels` : `no window ${name}; use hatch panels`);
  const p = await api('POST', `/api/panels/${encodeURIComponent(matches[0].id)}/convert`, { to: o.to });
  return console.log(`converted ${matches[0].id} (${matches[0].type}) to ${p.type}, now ${p.id}`);
}
/** Space-padded columns (name, state, kind, title) so the list scans easily; the last column is not padded. */
const widgetTable = (list) => {
  const rows = [['NAME', 'STATE', 'KIND', 'TITLE'], ...list.map((w) => [w.name, w.open ? 'open' : 'closed', w.example ? (w.name === 'trash' ? 'built-in' : 'example') : 'installed', w.title || ''])];
  const width = [0, 1, 2].map((c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => [...r.slice(0, 3).map((v, c) => v.padEnd(width[c])), r[3]].join('  ').trimEnd()).join('\n');
};
const say = (o, data, text) => console.log(o.json ? JSON.stringify(data, null, 2) : text);

const MINIMAL_WIDGET_HTML = `<!doctype html>
<meta charset="utf-8">
<style>body{margin:0;padding:12px;background:var(--bg,#111);color:var(--fg,#eee);font:14px var(--mono,monospace)}</style>
<div id="out">hello from a widget</div>
<script src="/sdk.js"></script>
<script>
  // hatch.on('SOURCE', (value) => { ... }) once widget.json declares a source
  hatch.log('widget loaded');
</script>
`;

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.endsWith('.tmp')) continue;
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

// Fence-aware split of claude's reply into index.html and optional widget.json. A reply with no fences is taken as html.
export function parseGenerated(text) {
  const fences = [...String(text).matchAll(/```([a-z]*)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1].toLowerCase(), body: m[2] }));
  const html = fences.find((f) => f.lang === 'html')?.body ?? (fences.length ? null : (String(text).includes('<') ? String(text) : null));
  const json = fences.find((f) => f.lang === 'json')?.body;
  return { html: html && html.trim() ? html.trim() + '\n' : null, json: json ? json.trim() + '\n' : null };
}

function generatePrompt(desc) {
  return `Write a small Hatch widget: ${desc}

Reply with ONLY these fenced blocks, no tools and no other text:
1. \`\`\`html  a complete single-file index.html (inline CSS and JS, no network, no external libraries).
2. Optionally \`\`\`json  a widget.json, only if it needs data sources.

${WIDGET_HELP}
Style with hatch.theme colours (or CSS variables) so it fits light and dark pages.`;
}

// `migrate` works on files, so it needs neither a running server nor an existing target.
async function migrateCommand(o, dirArg) {
  const mg = await import('../src/migrate.js');
  const { liveOwner } = await import('../src/instance-guard.js');
  const { shortPath } = await import('../src/instance.js');
  const target = chooseStateDir({ state: o.state }).dir;
  let src; let name; let r;
  try {
    src = mg.findSource(dirArg);
    name = o.name || mg.workspaceNameFor(src.project);
    need(name, `could not derive a workspace name from ${src.project}; pass --name NAME`);
    const dry = !!o['dry-run'];
    if (!dry && !fs.existsSync(target) && !o.yes) {
      if (!process.stdin.isTTY || !process.stderr.isTTY) throw new CliError(`${target} does not exist yet and there is no terminal to ask on; pass --yes to create it`);
      const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stderr });
      const answer = (await rl.question(`${target} does not exist. Create it and import ${shortPath(src.srcDir)} as workspace ${name}? [y/N] `)).trim().toLowerCase(); rl.close();
      if (answer !== 'y' && answer !== 'yes') throw new CliError('nothing changed');
    }
    r = mg.migrateProject({ srcDir: src.srcDir, target, name, dry });
  } catch (e) { if (e instanceof mg.MigrateError || e instanceof wsapi.WorkspaceError) throw new CliError(e.message); throw e; }
  console.log(`${o['dry-run'] ? 'DRY RUN, nothing was changed. Would migrate' : 'Migrated'} ${r.source} into ${r.target}`);
  for (const l of r.steps) console.log(`  ${l}`);
  if (r.conflicts.length) { console.log('conflicts (the existing setting was kept):'); for (const l of r.conflicts) console.log(`  ${l}`); }
  for (const l of r.notes) console.log(`note: ${l}`);
  const run = liveOwner(target); const old = liveOwner(r.source);
  if (run) console.log(`note: a server (pid ${run.pid}) runs on ${r.target}; it picks the changes up by itself.`);
  if (old) console.log(`note: the old instance (pid ${old.pid}) still runs; stop it before starting the per-user one (both default to port 7070).`);
  if (o['dry-run']) console.log('Run again without --dry-run to do it.');
  else console.log(`\n${mg.nextSteps({ target: r.target, source: r.source }).join('\n')}`);
}

async function main(argv) {
  // `diff` hands everything after it to git untouched (flags like --stat or --cached are not ours to parse)
  const firstPos = firstCommandIndex(argv);
  const di = firstPos >= 0 && (argv[firstPos] === 'diff' || argv[firstPos] === 'log' || argv[firstPos] === 'curl') ? firstPos : -1; // only when diff/log IS the command, not an argument of another one
  const diffArgs = di >= 0 ? argv.slice(di + 1) : null;
  const o = parse(diffArgs ? argv.slice(0, di + 1) : argv);
  const [cmd0, rawSub, ...rest] = o._;
  const rawCmd = cmd0 === 'w' ? 'widget' : cmd0; // `w` is short for `widget`
  const sub = rawCmd === 'popup' && rawSub === 'create' ? 'new' : rawSub;
  const cmd = rawCmd === 'popup' ? 'widget' : rawCmd;
  if (rawCmd === 'popup' && (!sub || o.help)) return console.log(COMMAND_HELP.popup);
  if (cmd === 'agent' && !sub) return console.log(COMMAND_HELP.agent);
  if (o.help && COMMAND_HELP[rawCmd]) return console.log(COMMAND_HELP[rawCmd]);
  if (cmd === 'widget' && sub === 'new' && o.help) return console.log(WIDGET_HELP);
  if (!cmd || o.help) return console.log(cmd === 'widget' ? WIDGET_HELP : HELP);

  if (cmd === 'agent') {
    const { agentInstructions, installAgentInstructions } = await import('../src/agent.js');
    if (sub === 'show') return console.log(agentInstructions());
    need(sub === 'init', 'usage: agent show | agent init [--target claude|codex|both] [--dir DIR]');
    for (const r of installAgentInstructions({ dir: o.dir, target: o.target })) console.log(`${r.changed ? 'updated' : 'already configured'} ${r.file}`);
    return;
  }

  if (cmd === 'doctor') { if (!printChecks(await doctor({ state: o.state }))) process.exitCode = 1; return; }

  if (cmd === 'migrate') return migrateCommand(o, rawSub);

  const dir = resolveStateDir({ state: o.state }).dir;
  const l = layout(dir);
  let geometry = {};
  if (o.size) {
    const m = /^(\d+)x(\d+)$/i.exec(o.size);
    need(m && +m[1] >= 180 && +m[1] <= 8192 && +m[2] >= 90 && +m[2] <= 8192, '--size must be WIDTHxHEIGHT (width 180–8192, height 90–8192)');
    geometry = { w: +m[1], h: +m[2] };
  }
  const rawApi = makeClient(dir);
  // The workspace of this command: --ws NAME, else $HATCH_WORKSPACE (Hatch sets it in each workspace's terminals), else main
  const ws = o.ws || process.env.HATCH_WORKSPACE || undefined;
  // it puts every window this command opens into that workspace
  const api = (m, r, b, x) => {
    if (m === 'POST' && (r === '/api/panels' || /^\/api\/examples\/[\w-]+\/open$/.test(r)) && b) b = { ...b, ...geometry, ...(ws && { ws }), ...(o['no-focus'] && { autoFocus: false }), ...((o.full || o.fullscreen) && { maximized: true }) };
    return rawApi(m, r, b, x);
  };

  switch (cmd) {
    case 'progress': {
      // Which plan: --plan NAME, else $HATCH_PLAN, else none (the server then uses the only plan, or refuses when there are several).
      const planName = o.plan || process.env.HATCH_PLAN || '';
      need(!planName || /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(planName), `plan name "${planName}" is not valid: use letters, digits, - and _ (at most 48)`);
      const pq = planName ? `?plan=${encodeURIComponent(planName)}` : '';
      if (sub === 'plans') {
        const list = await api('GET', '/api/progress/plans');
        if (o.json) return console.log(JSON.stringify(list, null, 2));
        return console.log(list.length ? list.map((x) => `${x.name}  ${x.done}/${x.steps} done`).join('\n') : 'no progress plans yet');
      }
      if (sub === 'close') {
        const target = planName || rest[0]; need(target, 'usage: progress close --plan NAME   (or: progress close NAME)');
        await api('DELETE', `/api/progress/plans/${encodeURIComponent(target)}`);
        return console.log(`plan ${target} closed`);
      }
      if (sub === 'open') {
        if (planName && planName !== 'default') {
          const p = await api('POST', '/api/panels', { type: 'progress', title: planName, placement: 'float', minimized: false, props: { plan: planName } });
          return console.log(`progress ${planName} open as ${p.id}`);
        }
        const p = await api('POST', '/api/panels', { type: 'progress', title: 'Progress', placement: 'float', minimized: false });
        return console.log(`progress open as ${p.id}`);
      }
      if (sub === 'plan') {
        need(rest.length, 'usage: progress plan "STEP" "STEP" ...');
        await api('PUT', `/api/progress/steps${pq}`, rest.map((title, i) => ({ id: `${slug(title)}_${i + 1}`, title, status: 'todo' })));
        return console.log(`plan created: ${rest.length} steps`);
      }
      if (sub === 'set') {
        need(rest[0], 'usage: progress set FILE|-');
        await api('PUT', `/api/progress/diagram${pq}`, readInput(rest[0]));
        return console.log('progress diagram updated');
      }
      if (sub === 'show' || !sub) {
        const p = await api('GET', `/api/progress${pq}`);
        if (o.json) return console.log(JSON.stringify(p, null, 2));
        console.log(p.diagram.trim() || '(no diagram)');
        for (const s of p.steps) console.log(`  [${s.status}] ${s.title} (${s.id})`);
        return;
      }
      if (sub === 'steps' && rest[0] === 'set') {
        need(rest[1], 'usage: progress steps set FILE|-');
        let steps; try { steps = JSON.parse(readInput(rest[1])); } catch (e) { throw new CliError(`steps file is not valid JSON: ${e.message}`); }
        await api('PUT', `/api/progress/steps${pq}`, steps);
        return console.log('steps replaced');
      }
      if (sub === 'step') {
        const [name, status] = rest;
        need(name && status, `usage: progress step "TITLE|ID" STATUS (${STEP_STATUS.join('|')})`);
        need(STEP_STATUS.includes(status), `status must be one of ${STEP_STATUS.join(', ')}`);
        const step = await api('POST', `/api/progress/steps${pq}`, { name, status, ...(o.detail !== undefined && { detail: o.detail }), ...(o.group !== undefined && { group: o.group }) });
        return console.log(`${step.title}: ${step.status}`);
      }
      throw new CliError('usage: progress set|show|plan|plans|close|steps set|step ... [--plan NAME]');
    }
    case 'widget': {
      const name = rest[0];
      if (rawCmd === 'popup' && sub === 'list') {
        const list = await api('GET', '/api/panels');
        return say(o, list, list.length ? list.map((p) => `${p.id.padEnd(14)} ${p.type.padEnd(9)} ${p.title}${p.minimized ? ' (minimized)' : ''}`).join('\n') : '(no popups open)');
      }
      if (rawCmd === 'popup' && sub === 'convert') return convertWindow(api, o, name);
      if (rawCmd === 'popup' && sub === 'close') {
        need(name, 'usage: popup close NAME|ID');
        const list = await api('GET', '/api/panels');
        const exact = list.find((p) => p.id === name || p.id === `w-${name}`);
        const matches = exact ? [exact] : list.filter((p) => p.type === name);
        need(matches.length === 1, matches.length ? `more than one ${name} popup is open; use hatch panels, then hatch close ID` : `no popup ${name}; use hatch popup list`);
        await api('DELETE', `/api/panels/${encodeURIComponent(matches[0].id)}`); return console.log(`closed ${matches[0].id}`);
      }
      if (rawCmd === 'popup' && sub === 'open' && ['progress', 'files', 'note'].includes(name)) {
        if (name === 'progress') {
          const p = await api('POST', '/api/panels', { type: 'progress', title: 'Progress', placement: 'float' });
          return console.log(`progress open as ${p.id}`);
        }
        const body = name === 'files'
          ? { type: 'files', title: o.title || 'Files', props: { path: path.resolve(rest[1] || process.cwd()) } }
          : { type: 'note', title: o.title || 'Note', props: { markdown: rest.slice(1).join(' ') || '# Note\n\nDouble-click to edit.' } };
        if (name === 'files') need(fs.existsSync(body.props.path) && fs.statSync(body.props.path).isDirectory(), `not a directory: ${body.props.path}`);
        const p = await api('POST', '/api/panels', body); return console.log(`${name} open as ${p.id}`);
      }
      if (rawCmd === 'popup' && sub === 'open' && rest[0] && name !== 'top') {
        // Examples now belong to `widget`; keep this working but point at the new command.
        const examples = await api('GET', '/api/examples');
        if (examples.some((e) => e.name === rest[0])) console.error(`hatch: popup open ${rest[0]} for examples is deprecated; use: hatch widget open ${rest[0]}`);
      }
      if (sub === 'examples') { const examples = await api('GET', '/api/examples'); const ex = rawCmd === 'popup' ? [{ name: 'progress', title: 'Progress' }, { name: 'files', title: 'Files' }, { name: 'note', title: 'Note' }, ...examples] : examples; return say(o, ex, ex.map((e) => `${e.name.padEnd(12)} ${e.title}`).join('\n')); }
      if (sub === 'list') {
        const installed = await api('GET', '/api/widgets');
        const have = new Set(installed.map((w) => w.name));
        const list = [...installed, ...(await api('GET', '/api/examples')).filter((e) => !have.has(e.name)).map((e) => ({ ...e, example: true }))];
        const hint = 'Create your own widgets, or ask AI to build a custom one: hatch widget generate "<prompt>"';
        return say(o, list, `${list.length ? widgetTable(list) : '(no widgets)'}\n\n${hint}`);
      }
      if (sub === 'generate') {
        const desc = rest.join(' ').trim(); need(desc, 'usage: widget generate "DESCRIPTION" [--name N]');
        const gname = o.name || slug(desc).slice(0, 30).replace(/_+$/g, '').replace(/_/g, '-') || 'widget'; checkName(gname);
        need(!fs.existsSync(path.join(l.widgets, gname)), `widgets/${gname} already exists: pick another with --name`);
        const bin = process.env.HATCH_CLAUDE || 'claude';
        const r = spawnSync(bin, ['-p'], { input: generatePrompt(desc), encoding: 'utf8', timeout: 300000, maxBuffer: 16 << 20 });
        need(!r.error || r.error.code !== 'ENOENT', `\`${bin}\` not found on PATH: install Claude Code, or set HATCH_CLAUDE to its path`);
        // A provider may exit before reading stdin (for example when logged out). Prefer its exit status and stderr.
        need(!r.error || (r.error.code === 'EPIPE' && r.status !== null), `could not run ${bin}: ${r.error?.message}`);
        need(r.status === 0, `${bin} -p failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ') || 'no output'}. Run \`${bin} -p hi\` to check it is logged in.`);
        const g = parseGenerated(r.stdout);
        need(g.html, 'claude did not return an html block, so nothing was created. Try again or word the description more concretely.');
        if (g.json) { try { JSON.parse(g.json); } catch { g.json = null; console.error('hatch: ignored the generated widget.json (not valid JSON)'); } }
        const wdir = path.join(l.widgets, gname); fs.mkdirSync(wdir, { recursive: true });
        fs.writeFileSync(path.join(wdir, 'index.html'), g.html);
        fs.writeFileSync(path.join(wdir, 'widget.json'), g.json || `${JSON.stringify({ title: gname }, null, 2)}\n`);
        await new Promise((res) => setTimeout(res, 250));
        const p = await api('POST', '/api/panels', { type: 'widget', props: { name: gname } });
        return console.log(`generated ${wdir}\nwidget ${gname} open as ${p.id}`);
      }
      need(['new', 'add', 'open', 'close', 'rm', 'reload'].includes(sub), 'usage: widget new|add|list|open|close|rm|reload');
      checkName(name);
      // "top" is a terminal window running htop, not the old widget, so keys work
      if (sub === 'open' && name === 'top') { const p = await api('POST', '/api/examples/top/open', {}); return console.log(`top open as ${p.id}`); }
      // "git" follows the shell: one widget per project, made by the server for this directory (the server does not know our cwd)
      if (sub === 'open' && name === 'git') { const p = await api('POST', '/api/examples/git/open', { dir: process.cwd() }); return console.log(`widget ${p.props.name} open as ${p.id}`); }
      const target = path.join(l.widgets, name);
      if (sub === 'open' && !fs.existsSync(path.join(target, 'index.html'))) {
        // Not installed: a bundled example of that name is copied in and opened by the server.
        const isExample = (await api('GET', '/api/examples')).some((e) => e.name === name);
        need(isExample, `no widget ${name}; see hatch widget list`);
        const p = await api('POST', `/api/examples/${encodeURIComponent(name)}/open`, {});
        return console.log(`${rawCmd === 'popup' ? 'popup' : 'widget'} ${name} open as ${p.id}`);
      }
      if (sub === 'new') {
        const from = o.from;
        need(!fs.existsSync(target), `widgets/${name} already exists`);
        if (from) {
          const src = path.join(EXAMPLES, from);
          need(NAME_RE.test(from) && fs.existsSync(src) && fs.statSync(src).isDirectory(), `no example ${from}; available: ${fs.readdirSync(EXAMPLES).join(', ')}`);
          copyDir(src, target);
        } else { // no --from: a minimal template instead of a copy of an example
          fs.mkdirSync(target, { recursive: true });
          fs.writeFileSync(path.join(target, 'index.html'), MINIMAL_WIDGET_HTML);
          fs.writeFileSync(path.join(target, 'widget.json'), `${JSON.stringify({ title: name, w: 300, h: 160, placement: 'float', sources: [] }, null, 2)}\n`);
        }
        if (rawCmd === 'popup') {
          const p = await api('POST', '/api/panels', { type: 'widget', props: { name } });
          return console.log(`created ${target}\npopup ${name} open as ${p.id}`);
        }
        return console.log(`created ${target}\nedit it; the page reloads on save. Open it with: hatch widget open ${name}`);
      }
      if (sub === 'add') {
        const from = rest[1];
        if (from) {
          need(fs.existsSync(from), `no such file or directory: ${from}`);
          fs.rmSync(target, { recursive: true, force: true });
          if (fs.statSync(from).isDirectory()) copyDir(from, target);
          else { fs.mkdirSync(target, { recursive: true }); fs.copyFileSync(from, path.join(target, 'index.html')); }
        }
        need(fs.existsSync(path.join(target, 'index.html')), `widgets/${name}/index.html is missing: pass a file or directory, or run \`widget new ${name}\` first`);
      }
      if (sub === 'rm') { await api('DELETE', `/api/widgets/${name}`); return console.log(`removed ${name}`); }
      if (sub === 'close') { await api('DELETE', `/api/panels/w-${name}`); return console.log(`closed ${name}`); }
      if (sub === 'reload') { await api('POST', `/api/widgets/${name}/reload`, {}); return console.log(`reloaded ${name}`); }
      // add and open: wait briefly for the watcher so the server knows the widget (it reads widget.json for defaults)
      await new Promise((r) => setTimeout(r, 250));
      const p = await api('POST', '/api/panels', { type: 'widget', props: { name } });
      console.log(`widget ${name} open as ${p.id}`);
      if (sub === 'open') { // a shipped example that changed since this instance copied it: say how to refresh (best effort)
        try { const ex = (await api('GET', '/api/examples')).find((e) => e.name === name && e.stale); if (ex) console.error(`hatch: ${ex.hint}`); } catch { /* the hint is optional */ }
      }
      return;
    }
    case 'image': {
      const file = sub; need(file, 'usage: image PATH [--title T]');
      const abs = path.resolve(file);
      need(fs.existsSync(abs), `no such file: ${abs}`);
      const p = await api('POST', '/api/panels', { type: 'image', title: o.title || path.basename(abs), props: { src: abs } });
      return console.log(`image open as ${p.id}`);
    }
    case 'term': {
      need(sub && NAME_RE.test(sub), 'usage: term NAME [--cmd CMD]   (NAME: letters, digits, - and _)');
      const p = await api('POST', '/api/panels', { type: 'terminal', title: o.title || `term: ${sub}`, props: { name: sub, ...(o.cmd && { cmd: o.cmd }) } });
      if (o.cmd) await api('POST', `/api/pterm/${sub}`, { cmd: o.cmd }); // start the session now so the command runs even before the window renders
      return console.log(`terminal ${sub} open as ${p.id}`);
    }
    case 'serve-dir': {
      const dirp = path.resolve(sub || '.'); need(fs.existsSync(dirp) && fs.statSync(dirp).isDirectory(), `not a directory: ${dirp}`);
      const probe = (p) => new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(p, '127.0.0.1', () => s.close(() => res(true))); });
      let port = Number(rest[0] || 0); if (!port) { for (let i = 0; i < 30 && !port; i++) { const c = 8000 + Math.floor(Math.random() * 1000); if (await probe(c)) port = c; } }
      need(port > 1023 && port < 65536, 'PORT must be between 1024 and 65535 (or no free port found)'); need(await probe(port), `port ${port} is already in use`);
      const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
      const cmd = `command -v python3 >/dev/null 2>&1 || { echo 'python3 is needed'; exit 127; }; cd ${q(dirp)} && exec python3 -m http.server ${port} --bind 127.0.0.1`;
      const r = await api('POST', '/api/runs', { cmd, cwd: dirp });
      await api('POST', '/api/panels', { type: 'output', title: `serve :${port}`, props: { cmd: `serve ${dirp} on :${port}`, runId: r.id, cwd: dirp } });
      await new Promise((res) => setTimeout(res, 700)); // let the server bind before the iframe asks for it
      const p = await api('POST', '/api/panels', { type: 'iframe', title: path.basename(dirp) || dirp, props: { url: `/proxy/${port}/` } });
      return console.log(`serving ${dirp} at /proxy/${port}/ (window ${p.id}); Stop it from its output window`);
    }
    case 'host': {
      // list/stop come first so they are never taken for a file name (host ./list hosts a file called list)
      if (sub === 'list') {
        const l = await api('GET', '/api/host');
        const rows = [['ID', 'FILE', 'FOLDER', 'LINK PATH'], ...l.map((h) => [h.id, h.entry, h.dir, h.path])];
        const w = [0, 1, 2].map((c) => Math.max(...rows.map((r) => r[c].length)));
        return say(o, l, l.length ? rows.map((r) => [...r.slice(0, 3).map((v, c) => v.padEnd(w[c])), r[3]].join('  ')).join('\n') : 'nothing hosted');
      }
      if (sub === 'stop') {
        need(o.all || rest[0], 'usage: host stop ID | host stop --all');
        if (o.all) { const r = await api('DELETE', '/api/host'); return console.log(`stopped hosting ${r.stopped} page${r.stopped === 1 ? '' : 's'}`); }
        await api('DELETE', `/api/host/${encodeURIComponent(rest[0])}`); return console.log(`stopped hosting ${rest[0]}`);
      }
      need(sub, 'usage: host FILE.html'); const f = path.resolve(sub); need(fs.existsSync(f) && fs.statSync(f).isFile(), `no such file: ${f}`);
      const folder = path.dirname(f);
      const warn = `Anyone logged in to this Hatch can read the whole folder ${folder} (everything in it except dotfiles), not only ${path.basename(f)}. Host only what you are fine sharing with them.`;
      if (o.yes) console.error(`Warning: ${warn}`);
      else {
        console.error(`Hosting ${f}\nWarning: ${warn}\nThe page runs in a sandbox: its scripts cannot read the Hatch cookie or call the Hatch API.`);
        if (!process.stdin.isTTY || !process.stderr.isTTY) throw new CliError('there is no terminal to ask on; pass --yes to host this page anyway');
        const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stderr });
        const answer = (await rl.question('Continue? [y/N] ')).trim().toLowerCase(); rl.close();
        if (answer !== 'y' && answer !== 'yes') throw new CliError('nothing hosted');
      }
      const h = await api('POST', '/api/host', { file: f, ...(ws && { ws }), ...(o['no-open'] && { open: false }) }); const c = readConfig(dir);
      // The address this CLI talks to ($HATCH_URL, else the local server), not the LAN address: behind a reverse proxy the browser's own address differs, which is why the UI builds the URL itself.
      const base = (process.env.HATCH_URL || `http://127.0.0.1:${c.port}`).replace(/\/+$/, '');
      // The link never carries a secret: the page opens in a browser that is logged in to Hatch (the cookie is the login), otherwise the browser shows the login page first.
      console.log(`${base}${h.path}`);
      if (h.opened) console.error(`Opened in ${h.opened} Hatch browser tab${h.opened === 1 ? '' : 's'} (if the browser blocked the pop-up, click "Open hosted page" there). Only one tab opens it per browser.`);
      else console.error(o['no-open'] ? 'Not opened in the browser (--no-open).' : 'No Hatch browser tab received it; open the link above in a browser that is logged in to Hatch (log in first, then open the link).');
      console.error('The page is read-only; the folder it is in is served, dotfiles are not. Only browsers logged in to this Hatch can open it. Absolute paths like /style.css in the page do not load: use relative ones.');
      return;
    }
    case 'files': {
      const dirp = path.resolve(sub || process.cwd()); need(fs.existsSync(dirp) && fs.statSync(dirp).isDirectory(), `not a directory: ${dirp}`);
      const p = await api('POST', '/api/panels', { type: 'files', title: o.title || 'Files', props: { path: dirp } });
      return console.log(`files open as ${p.id}`);
    }
    case 'edit': {
      need(sub, 'usage: edit FILE[:LINE]'); const m = /^(.*?):(\d+)(?::\d+)?$/.exec(sub); const target = m && !fs.existsSync(sub) ? m[1] : sub; const line = m && !fs.existsSync(sub) ? Number(m[2]) : undefined;
      const f = path.resolve(target); need(fs.existsSync(f) && fs.statSync(f).isFile(), `no such file: ${f}`);
      const p = await api('POST', '/api/panels', { type: 'editor', title: o.title || path.basename(f), props: { path: f, ...(line && { line }) } });
      return console.log(`${p.type === 'terminal' ? 'vim' : 'editor'} open as ${p.id}`);
    }
    case 'open': {
      need(sub, 'usage: open FILE|DIR|URL [--title T] [--direct]');
      if (!/^https?:\/\//i.test(sub)) {
        const f = path.resolve(sub);
        need(fs.existsSync(f), `no such file or directory: ${f}`);
        const type = openTypeFor(f, fs.statSync(f).isDirectory());
        const p = await api('POST', '/api/panels', { type, title: o.title || path.basename(f), props: type === 'image' ? { src: f } : { path: f } });
        return console.log(`${p.type} open as ${p.id}`);
      }
      // `localhost` in a URL means the BOX (that is what Claude means), but the browser would resolve it on the user's machine:
      // go through Hatch's proxy unless --direct is given
      let url = sub; const lm = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)(\/.*)?$/i.exec(sub);
      if (lm && !o.direct) url = `/proxy/${lm[1]}${lm[2] || '/'}`;
      const p = await api('POST', '/api/panels', { type: 'iframe', title: o.title || sub, props: { url } });
      return console.log(`opened ${url === sub ? sub : `${sub} (through the Hatch proxy: ${url})`} as ${p.id}`);
    }
    case 'note': {
      need(sub, 'usage: note "markdown" [--title T]');
      const p = await api('POST', '/api/panels', { type: 'note', title: o.title || 'Note', props: { markdown: sub === '-' ? fs.readFileSync(0, 'utf8') : sub } });
      return console.log(`note open as ${p.id}`);
    }
    case 'panels': {
      const list = await api('GET', '/api/panels');
      return say(o, list, list.length ? list.map((p) => `${p.id}  ${p.type}  ${p.placement}  ${p.title}`).join('\n') : '(no panels open)');
    }
    case 'minimize':
    case 'restore': {
      need(sub, `usage: ${cmd} ID`);
      await api('PATCH', `/api/panels/${encodeURIComponent(sub)}`, { minimized: cmd === 'minimize', ...(cmd === 'restore' && { autoFocus: !o['no-focus'], activation: randomUUID() }) });
      return console.log(`${cmd} ${sub}`);
    }
    case 'convert': return convertWindow(api, o, sub);
    case 'close': { need(sub, 'usage: close ID'); await api('DELETE', `/api/panels/${sub}`); return console.log(`closed ${sub}`); }
    case 'notify': {
      need(sub, 'usage: notify "text" [--level info|warn|done]');
      need(!o.level || ['info', 'warn', 'done'].includes(o.level), 'level must be info, warn or done');
      await api('POST', '/api/notify', { text: sub, level: o.level || 'info' });
      return console.log('notified');
    }
    case 'prompt': {
      const list = await api('GET', '/api/commands'); const prompts = list.filter((c) => c.paste);
      if (sub === 'list' || !sub) return say(o, prompts, prompts.length ? prompts.map((c) => `${c.name}: ${c.text.split('\n')[0].slice(0, 70)}${c.text.includes('\n') ? ' ...' : ''}`).join('\n') : '(no saved prompts)');
      if (sub === 'add') {
        const [name, ...words] = rest; need(name && words.length, 'usage: prompt add NAME TEXT|-'); const text = words.join(' ') === '-' ? fs.readFileSync(0, 'utf8').trimEnd() : words.join(' '); need(text, 'empty prompt');
        await api('PUT', '/api/commands', [...list.filter((c) => c.name !== name), { name, text, enter: false, paste: true }]); return console.log(`saved prompt ${name}`);
      }
      if (sub === 'rm') { need(rest[0] && prompts.some((c) => c.name === rest[0]), `no prompt ${rest[0] || ''}`.trim()); await api('PUT', '/api/commands', list.filter((c) => c.name !== rest[0])); return console.log(`removed ${rest[0]}`); }
      throw new CliError('usage: prompt add|list|rm');
    }
    case 'cmd': {
      const list = await api('GET', '/api/commands');
      if (sub === 'list') return say(o, list, list.length ? list.map((c) => `${c.name}: ${c.text}`).join('\n') : '(no saved commands)');
      if (sub === 'add') {
        const [name, ...words] = rest; need(name && words.length, 'usage: cmd add NAME TEXT [--no-enter]');
        await api('PUT', '/api/commands', [...list.filter((c) => c.name !== name), { name, text: words.join(' '), enter: !o['no-enter'] }]);
        return console.log(`saved command ${name}`);
      }
      if (sub === 'rm') { need(rest[0], 'usage: cmd rm NAME'); need(list.some((c) => c.name === rest[0]), `no saved command ${rest[0]}`); await api('PUT', '/api/commands', list.filter((c) => c.name !== rest[0])); return console.log(`removed ${rest[0]}`); }
      throw new CliError('usage: cmd add|list|rm');
    }
    case 'watch': {
      const list = await api('GET', '/api/watches');
      const put = (next) => api('PUT', '/api/watches', next);
      if (sub === 'list') return say(o, list, list.length ? list.map((w) => `${w.name}: ${w.pattern ? `/${w.pattern}/` : `idle ${w.idleSec}s`} (${w.level || 'info'})`).join('\n') : '(no watches)');
      if (sub === 'add') {
        const name = rest[0]; need(name && o.pattern, 'usage: watch add NAME --pattern REGEX [--level L] [--cooldown SEC]');
        try { new RegExp(o.pattern); } catch (e) { throw new CliError(`bad pattern: ${e.message}`); }
        await put([...list.filter((w) => w.name !== name), { name, pattern: o.pattern, level: o.level || 'info', cooldownSec: Number(o.cooldown) || 30 }]);
        return console.log(`watching for /${o.pattern}/ as ${name}`);
      }
      if (sub === 'idle') {
        const sec = Number(rest[0]); need(sec > 0, 'usage: watch idle SECONDS [--name N]');
        const name = o.name || 'idle'; await put([...list.filter((w) => w.name !== name), { name, idleSec: sec, level: o.level || 'done' }]);
        return console.log(`notifying after ${sec}s without terminal output`);
      }
      if (sub === 'rm') { need(rest[0] && list.some((w) => w.name === rest[0]), `no watch ${rest[0] || ''}`.trim()); await put(list.filter((w) => w.name !== rest[0])); return console.log(`removed ${rest[0]}`); }
      throw new CliError('usage: watch add|idle|list|rm');
    }
    case 'every': {
      const sec = parseEvery(sub); need(sec && sec >= 10, 'usage: every INTERVAL "CMD" (INTERVAL like 30s, 5m, 2h; at least 10s)'); const cmd = rest.join(' ').trim(); need(cmd, 'usage: every INTERVAL "CMD"');
      const list = await api('GET', '/api/schedules'); const name = o.name || cmd.slice(0, 40);
      await api('PUT', '/api/schedules', [...list.filter((s) => s.name !== name).map(({ name: n, cmd: c, everySec, always }) => ({ name: n, cmd: c, everySec, always })), { name, cmd, everySec: sec, always: !!o.always }]);
      return console.log(`scheduled ${name}: every ${sec}s (${o.always ? 'notify after every run' : 'notify when pass/fail changes'})`);
    }
    case 'schedules': { const l = await api('GET', '/api/schedules'); return say(o, l, l.length ? l.map((s) => `${s.name.padEnd(24)} every ${s.everySec}s  ${s.running ? 'running' : s.last ? `last exit ${s.last.code}` : 'not run yet'}  next in ${s.nextInSec}s`).join('\n') : '(no schedules)'); }
    case 'unschedule': {
      const list = await api('GET', '/api/schedules'); need(sub && list.some((s) => s.name === sub), `no schedule ${sub || ''}`.trim());
      await api('PUT', '/api/schedules', list.filter((s) => s.name !== sub).map(({ name: n, cmd: c, everySec, always }) => ({ name: n, cmd: c, everySec, always }))); return console.log(`removed ${sub}`);
    }
    case 'bookmark': {
      const list = await api('GET', '/api/bookmarks'); const put = (next) => api('PUT', '/api/bookmarks', next.map(({ name, path: p }) => ({ name, path: p })));
      if (sub === 'list' || !sub) return say(o, list, list.length ? list.map((b) => `${b.name.padEnd(16)} ${b.kind.padEnd(7)} ${b.path}`).join('\n') : '(no bookmarks)');
      if (sub === 'add') { const [name, where] = rest; need(name, 'usage: bookmark add NAME [PATH]'); const abs = path.resolve(where || process.cwd()); need(fs.existsSync(abs), `no such file or folder: ${abs}`); await put([...list.filter((b) => b.name !== name), { name, path: abs }]); return console.log(`bookmarked ${name} -> ${abs}`); }
      if (sub === 'rm') { need(rest[0] && list.some((b) => b.name === rest[0]), `no bookmark ${rest[0] || ''}`.trim()); await put(list.filter((b) => b.name !== rest[0])); return console.log(`removed ${rest[0]}`); }
      throw new CliError('usage: bookmark add|list|rm');
    }
    case 'trash': {
      if (sub === 'restore') { const p = await api('POST', '/api/trash/restore', { trashId: rest[0] }); return console.log(`reopened ${p.id} (${p.title})`); }
      if (sub === 'empty') { const r = await api('DELETE', '/api/trash'); return console.log(`emptied the trash (${r.removed} windows)`); }
      need(!sub || sub === 'list', 'usage: trash [list] | restore [TRASH_ID] | empty');
      const list = await api('GET', '/api/trash');
      return say(o, list, list.length ? list.map((e) => `${e.trashId}  ${e.type}  ${e.title}`).join('\n') : '(trash is empty)');
    }
    case 'ask': {
      need(sub, 'usage: ask "question" [CHOICE ...] [--text] [--timeout SEC]');
      need(o.timeout === undefined || (Number.isFinite(Number(o.timeout) * 1000) && Number(o.timeout) > 0), '--timeout must be a positive finite number of seconds');
      const { id } = await api('POST', '/api/ask', { question: sub, choices: rest, freeText: !!o.text });
      const until = o.timeout ? Date.now() + Number(o.timeout) * 1000 : Infinity;
      const cancel = () => { api('DELETE', `/api/ask/${id}`).catch(() => {}).finally(() => process.exit(130)); };
      process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
      for (;;) {
        const r = await api('GET', `/api/ask/${id}`);
        if (r.answered) return console.log(r.answer);
        if (Date.now() > until) { await api('DELETE', `/api/ask/${id}`).catch(() => {}); process.exitCode = 3; return console.error('hatch: no answer before the timeout'); }
        await new Promise((res) => setTimeout(res, 400));
      }
    }
    case 'grep': {
      need(sub, 'usage: grep PATTERN [DIR]'); const dir = path.resolve(rest[0] || '.');
      const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
      const cmd = `if command -v rg >/dev/null 2>&1; then rg -n --no-heading --color never -- ${q(sub)} ${q(dir)}; else grep -rnI --exclude-dir=.git --exclude-dir=node_modules -- ${q(sub)} ${q(dir)}; fi`;
      const r = await api('POST', '/api/runs', { cmd, cwd: process.cwd() });
      const p = await api('POST', '/api/panels', { type: 'output', title: `grep ${sub}`.slice(0, 40), props: { cmd: `grep ${sub} ${dir}`, runId: r.id, cwd: process.cwd(), rerun: cmd } });
      return console.log(`searching in window ${p.id}`);
    }
    case 'diff': {
      const args = (diffArgs || []).map((x) => `'${String(x).replace(/'/g, `'\\''`)}'`).join(' ');
      const cmd = `git --no-pager diff --no-color ${args}`;
      const r = await api('POST', '/api/runs', { cmd, cwd: process.cwd() });
      const p = await api('POST', '/api/panels', { type: 'output', title: 'git diff', props: { cmd: `git diff ${(diffArgs || []).join(' ')}`.trim(), runId: r.id, cwd: process.cwd(), kind: 'diff', rerun: cmd } });
      return console.log(`diff in window ${p.id}`);
    }
    case 'curl': {
      need(diffArgs && diffArgs.length, 'usage: curl [CURL-ARGS...] URL   e.g. curl -X POST -d @body.json http://localhost:3000/api');
      const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
      // --max-time keeps a hung server from leaving the window running forever; -i shows the status line and headers
      const cmd = `command -v curl >/dev/null 2>&1 || { echo 'curl is not installed on this box'; exit 127; }; curl -sS -i --max-time 30 ${diffArgs.map(q).join(' ')}`;
      const r = await api('POST', '/api/runs', { cmd, cwd: process.cwd() });
      const p = await api('POST', '/api/panels', { type: 'output', title: `curl ${diffArgs.filter((a) => !a.startsWith('-')).pop() || ''}`.slice(0, 40), props: { cmd: `curl ${diffArgs.join(' ')}`, runId: r.id, cwd: process.cwd(), rerun: cmd } });
      return console.log(`request in window ${p.id}`);
    }
    case 'diff-files': {
      const [a, b] = [sub, rest[0]]; need(a && b, 'usage: diff-files A B'); for (const f of [a, b]) need(fs.existsSync(f) && fs.statSync(f).isFile(), `no such file: ${f}`);
      const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`; const cmd = `diff -u ${q(path.resolve(a))} ${q(path.resolve(b))}; [ $? -le 1 ]`; // diff exits 1 when files differ: that is not a failure here
      const r = await api('POST', '/api/runs', { cmd, cwd: process.cwd() });
      const p = await api('POST', '/api/panels', { type: 'output', title: `${path.basename(a)} vs ${path.basename(b)}`.slice(0, 40), props: { cmd: `diff ${a} ${b}`, runId: r.id, cwd: process.cwd(), kind: 'diff', rerun: cmd } });
      return console.log(`comparison in window ${p.id}`);
    }
    case 'man': {
      need(sub, 'usage: man PAGE [SECTION]'); const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
      const cmd = `MANWIDTH=100 man ${rest[0] ? `${q(rest[0])} ` : ''}${q(sub)} 2>&1 | col -bx`;
      const r = await api('POST', '/api/runs', { cmd, cwd: process.cwd() });
      const p = await api('POST', '/api/panels', { type: 'output', title: `man ${sub}`, props: { cmd: `man ${sub}`, runId: r.id, cwd: process.cwd(), rerun: cmd } });
      return console.log(`man page in window ${p.id}`);
    }
    case 'tail': {
      need(sub, 'usage: tail FILE'); const f = path.resolve(sub); need(fs.existsSync(f), `no such file: ${f}`);
      const cmd = `tail -n 100 -F '${f.replace(/'/g, `'\\''`)}'`;
      const r = await api('POST', '/api/runs', { cmd, cwd: process.cwd() });
      const p = await api('POST', '/api/panels', { type: 'output', title: `tail ${path.basename(f)}`, props: { cmd: `tail -F ${f}`, runId: r.id, cwd: process.cwd(), rerun: cmd } });
      return console.log(`following ${f} in window ${p.id}`);
    }
    case 'log': {
      const args = (diffArgs || []).map((x) => `'${String(x).replace(/'/g, `'\\''`)}'`).join(' ');
      const cmd = `git --no-pager log --no-color ${args || '--oneline -30'}`;
      const r = await api('POST', '/api/runs', { cmd, cwd: process.cwd() });
      const p = await api('POST', '/api/panels', { type: 'output', title: 'git log', props: { cmd: 'git log', runId: r.id, cwd: process.cwd(), rerun: cmd } });
      return console.log(`log in window ${p.id}`);
    }
    case 'runs': {
      const list = await api('GET', '/api/runs');
      if (o.open) { const want = o.open === true ? sub : o.open; const r = list.find((x) => x.id === want); need(r, `no run ${want || ''}; see: hatch runs`.replace('no run ;', 'which run? see:')); const p = await api('POST', '/api/panels', { type: 'output', title: r.cmd.slice(0, 40), props: { cmd: r.cmd, runId: r.id, cwd: r.cwd } }); return console.log(`run ${r.id} open as ${p.id}`); }
      return say(o, list, list.length ? list.map((r) => `${r.id.padEnd(12)} ${(r.state === 'running' ? 'running' : `exit ${r.code}`).padEnd(9)} ${r.cmd.slice(0, 70)}`).join('\n') : '(no runs since the server started)');
    }
    case 'run': {
      need(sub, 'usage: run "CMD" [--title T] [--wait]');
      const r = await api('POST', '/api/runs', { cmd: sub, cwd: process.cwd() });
      const p = await api('POST', '/api/panels', { type: 'output', title: o.title || sub.slice(0, 40), props: { cmd: sub, runId: r.id, cwd: process.cwd() } });
      console.log(`running as ${r.id} in window ${p.id}`);
      if (o.wait) for (;;) { const v = await api('GET', `/api/runs/${r.id}`); if (v.state === 'done') { process.exitCode = Number.isInteger(v.code) && v.code >= 0 && v.code <= 255 ? v.code : 1; return console.log(`exit ${v.code}`); } await new Promise((res) => setTimeout(res, 400)); }
      return;
    }
    case 'git': {
      const dirp = path.resolve(sub || process.cwd()); need(fs.existsSync(dirp), `no such directory: ${dirp}`);
      const p = await api('POST', '/api/panels', { type: 'git', title: o.title || 'Git', props: { dir: dirp } });
      return console.log(`git window ${p.id}`);
    }
    case 'tasks': {
      const list = await api('GET', '/api/tasks');
      if (o.run) {
        const t = list.find((x) => x.name === o.run); need(t, `no task ${o.run}; available: ${list.map((x) => x.name).join(', ') || 'none'}`);
        const r = await api('POST', '/api/runs', { cmd: t.cmd }); // the task list comes from the server's directory, so it runs there too
        const p = await api('POST', '/api/panels', { type: 'output', title: t.cmd, props: { cmd: t.cmd, runId: r.id } });
        return console.log(`running ${t.cmd} in window ${p.id}`);
      }
      return say(o, list, list.length ? list.map((t) => `${t.name.padEnd(16)} ${t.cmd}  (${t.source})`).join('\n') : '(no package.json scripts or Makefile targets found)');
    }
    case 'ports': { const list = await api('GET', '/api/ports'); return say(o, list, list.length ? list.map((x) => `${String(x.port).padEnd(6)} ${x.scope.padEnd(16)} ${x.process || ''}`).join('\n') : '(nothing is listening)'); }
    case 'export': {
      const SHARED = ['commands.json', 'watches.json', 'schedules.json', 'bookmarks.json', 'custom.css', 'custom.js', 'widgets'];
      const present = SHARED.filter((n) => fs.existsSync(path.join(dir, n))); need(present.length, 'nothing to export yet (no saved commands, widgets, ...)');
      const out = path.resolve(sub || `hatch-setup-${new Date().toISOString().slice(0, 10)}.tgz`);
      const r = spawnSync('tar', ['-czf', out, '-C', dir, ...present], { encoding: 'utf8' }); need(r.status === 0, `tar failed: ${(r.stderr || r.error?.message || '').trim() || 'is tar installed?'}`);
      return console.log(`saved ${present.join(', ')} to ${out}`);
    }
    case 'import': {
      need(sub && fs.existsSync(sub), 'usage: import FILE.tgz [--force]'); const file = path.resolve(sub);
      const list = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' }); need(list.status === 0, `not a readable tgz: ${file}`);
      const ALLOWED = /^(commands\.json|watches\.json|schedules\.json|bookmarks\.json|custom\.css|custom\.js|layouts(\/|$)|widgets(\/|$))/; // layouts: archives made before that feature was cut still import (it is skipped below)
      const names = list.stdout.split('\n').filter(Boolean).map((n) => n.replace(/^\.\//, ''));
      const bad = names.find((n) => !ALLOWED.test(n) || n.split('/').includes('..') || path.isAbsolute(n)); need(!bad, `refusing: the archive contains ${bad}, which is not part of a Hatch setup`);
      // only plain files and folders: a symlink entry could let a later entry write outside the state dir
      const verbose = spawnSync('tar', ['-tvzf', file], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
      const odd = verbose.find((l) => !/^[-d]/.test(l)); need(!odd, `refusing: the archive contains a link or special file (${odd?.split(/\s+/).slice(5).join(' ')})`);
      const r = spawnSync('tar', ['-xzf', file, '-C', dir, '--no-same-owner', '--no-same-permissions', '--exclude=layouts', '--exclude=layouts/*', ...(o.force ? [] : ['--skip-old-files'])], { encoding: 'utf8' }); need(r.status === 0, `tar failed: ${(r.stderr || '').trim()}`);
      return console.log(`restored ${names.filter((n) => !n.includes('/') || n.endsWith('/')).length} items into ${dir}${o.force ? ' (overwriting)' : ' (existing files kept; --force overwrites)'}`);
    }
    case 'report': {
      const md = await api('GET', '/api/report', undefined, { raw: true });
      if (o.out) { fs.writeFileSync(path.resolve(o.out), md); console.log(`wrote ${path.resolve(o.out)}`); }
      if (o.open) { const p = await api('POST', '/api/panels', { type: 'note', title: 'Session report', props: { markdown: md } }); return console.log(`report open as ${p.id}`); }
      if (!o.out) console.log(md);
      return;
    }
    case 'copy': {
      need(sub, 'usage: copy "text"   or   some-command | hatch copy -'); const text = sub === '-' ? fs.readFileSync(0, 'utf8') : [sub, ...rest].join(' ');
      need(text, 'nothing to copy'); const r = await api('POST', '/api/copy', { text, label: o.label || '' });
      return console.log(`sent ${r.bytes} bytes to the browser clipboard`);
    }
    case 'fx': {
      if (sub === 'list') { const f = readFx(dir); return say(o, { effect: f.effect, effects: EFFECTS.map((name) => ({ name, active: name === f.effect, intensity: f.intensities[name] ?? 50 })) }, [...EFFECTS, 'off'].map((n) => `${n === (f.effect || 'off') ? '*' : ' '} ${n}`).join('\n')); }
      if (!sub && o.intensity === undefined) { const f = readFx(dir); return say(o, { effect: f.effect, intensity: f.intensity, intensities: f.intensities, effects: EFFECTS }, `active: ${f.effect || 'none'}${f.effect ? ` (intensity ${f.intensity}, 0-100)` : ''}${f.problem ? ` (${f.problem})` : ''}\neffects: ${EFFECTS.join(', ')}, off`); }
      try { const f = setFx(dir, sub, o.intensity); return console.log(f.effect ? `fx ${f.effect} on, intensity ${f.intensity}; \`hatch fx off\` turns it off. Open pages update by themselves.` : 'fx off'); }
      catch (e) { if (e instanceof FxError) throw new CliError(e.message); throw e; }
    }
    case 'workspace': {
      const usage = 'usage: workspace list | new NAME | rename OLD NEW | close NAME --confirm NAME | import STATE-DIR [NAME]';
      const enc = encodeURIComponent;
      if (!sub || sub === 'list') {
        const list = await api('GET', '/api/workspaces');
        return say(o, list, list.map((w) => `${w.name}${w.name === 'main' ? ' (default)' : ''}  ${w.windows} window${w.windows === 1 ? '' : 's'}${w.background ? '  background' : ''}`).join('\n'));
      }
      if (sub === 'new') { need(rest[0], usage); const w = await api('POST', '/api/workspaces', { name: rest[0] }); return console.log(`workspace ${w.name} created; open pages list it, or use /#${w.name}`); }
      if (sub === 'rename') { need(rest[0] && rest[1], usage); await api('POST', `/api/workspaces/${enc(rest[0])}/rename`, { to: rest[1] }); return console.log(`workspace ${rest[0]} is now ${rest[1]}`); }
      if (sub === 'close') {
        need(rest[0], usage);
        need(o.confirm === rest[0], `closing ${rest[0]} ends its terminals and closes its windows; run again with --confirm ${rest[0]} (the exact name) to go ahead`);
        const r = await api('DELETE', `/api/workspaces/${enc(rest[0])}`, { confirm: o.confirm });
        return console.log(`workspace ${rest[0]} closed (${r.closedWindows} window${r.closedWindows === 1 ? '' : 's'})`);
      }
      if (sub === 'import') {
        need(rest[0], usage);
        const src = path.resolve(rest[0]);
        const name = rest[1] || path.basename(path.dirname(src)).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
        need(name, 'could not derive a workspace name from the folder; pass one: workspace import STATE-DIR NAME');
        wsapi.migrate(dir); // a state dir that never ran a workspace-aware server gets its registry first
        let r; try { r = wsapi.importState(dir, src, name); } catch (e) { if (e instanceof wsapi.WorkspaceError) throw new CliError(e.message); throw e; }
        console.log(`imported ${r.windows} window${r.windows === 1 ? '' : 's'} into workspace ${r.workspace}${r.created ? ' (new)' : ''}; terminal windows start fresh shells`);
        for (const x of r.skipped) console.log(`  skipped: ${x}`);
        return;
      }
      throw new CliError(usage);
    }
    case 'set': {
      // --ws NAME: the background (and its fit mode) of that workspace instead of main
      let bgDir = dir;
      if (ws && ws !== 'main' && (sub === 'background' || sub === 'background-mode')) {
        try { bgDir = wsapi.workspaceDir(dir, wsapi.findWorkspace(dir, ws, [])); } catch (e) { if (e instanceof wsapi.WorkspaceError) throw new CliError(e.message); throw e; }
      }
      const usage = 'usage: set background IMAGE|none, set background-mode fill|fit|stretch|center|tile, set transparency 0..100, set window-transparency 0..100|default|follow';
      if (sub === 'transparency') {
        need(rest[0], usage);
        try { transparency.setTransparency(dir, rest[0]); } catch (e) { if (e instanceof transparency.TransparencyError) throw new CliError(`${e.message} (transparency left unchanged)`); throw e; }
        return console.log(`transparency ${Number(rest[0])} saved in ${dir}; open pages update by themselves`);
      }
      if (sub === 'window-transparency') {
        need(rest[0], usage);
        let n; try { n = transparency.setWindowTransparency(dir, rest[0]); } catch (e) { if (e instanceof transparency.TransparencyError) throw new CliError(`${e.message}, or default or follow (window transparency left unchanged)`); throw e; }
        return console.log(String(rest[0]).trim() === 'default' ? `windows are opaque again, the built-in default 0 (saved in ${dir}; open pages update by themselves)` : n === 'follow' ? `windows follow the terminal/page transparency (saved in ${dir}; open pages update by themselves)` : `window transparency ${n} saved in ${dir}; windows without their own setting update by themselves`);
      }
      if (sub === 'background-mode') {
        need(rest[0], usage);
        try { background.setMode(bgDir, rest[0]); } catch (e) { if (e instanceof background.BackgroundError) throw new CliError(`${e.message} (mode left unchanged)`); throw e; }
        return console.log(`background mode ${rest[0]} saved in ${bgDir}; open pages update by themselves`);
      }
      if (sub !== 'background') throw new CliError(usage);
      need(rest[0], usage);
      if (rest[0] === 'none') return console.log(background.clearBackground(bgDir) ? 'background removed' : 'no background was set');
      try { background.setBackground(bgDir, background.readImageFile(path.resolve(rest[0]))); }
      catch (e) { if (e instanceof background.BackgroundError) throw new CliError(`${e.message} (background left unchanged)`); throw e; }
      return console.log(`background saved in ${bgDir}; open pages update by themselves (the server must be running to show it)`);
    }
    case 'windows': {
      const usage = 'usage: windows transparency 0..100';
      if (sub !== 'transparency') throw new CliError(usage);
      need(rest[0], usage);
      if (!/^\d{1,3}$/.test(rest[0]) || Number(rest[0]) > 100) throw new CliError(`invalid transparency ${JSON.stringify(rest[0])}; use a whole number from 0 (opaque) to 100 (windows stay at least 20% visible) (nothing changed)`);
      const r = await api('POST', '/api/panels/transparency', { percent: Number(rest[0]) });
      return console.log(`${r.changed} window${r.changed === 1 ? '' : 's'} set to transparency ${Number(rest[0])}`);
    }
    case 'desktop': { const r = await api('POST', '/api/desktop', {}); return console.log(`desktop open: ${r.opened.join(', ')}`); }
    case 'upload-dir': return console.log(l.uploads);
    default: throw new CliError(`unknown command ${cmd}. Try \`hatch --help\`.`);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`hatch: ${e.message}`);
  process.exit(e instanceof CliError ? e.code : 1);
});
