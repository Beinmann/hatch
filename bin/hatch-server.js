#!/usr/bin/env node
// hatch-server: serve | clear | update-widgets | start | stop | restart | status | url | doctor | service | agent (the page-driving commands are `hatch`)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { firstCommandIndex, withoutOption } from '../src/cli-options.js';
import { spawnSync } from 'node:child_process';
import { createHatch } from '../src/server.js';
import { DEFAULT_PORT, listenFromPort } from '../src/free-port.js';
import { doctor, printChecks } from '../src/doctor.js';
import { findStateDir, chooseStateDir, isValidStateDir, readConfig, linkHost, isLoopbackHost } from '../src/find.js';
import { shortPath } from '../src/instance.js';

const HELP = `hatch-server: run and administer the Hatch server. (To drive the page from the terminal use \`hatch\`.)

usage:
  hatch-server serve [--host H] [--port N] [--state DIR] [--session NAME] [--cwd DIR] [--root DIR] [--view-only] [--tmux-status] [--yes]
  hatch-server start|stop|restart|status [serve options]   run the server in the background (pid in <state>/hatch.pid, log in <state>/log/daemon.log)
  hatch-server agent init [--target claude|codex|both]     add persistent project instructions (same as hatch agent init)
  hatch-server clear [--state DIR] [--yes]   delete everything in the state dir except allowed-hosts (widgets, notes, trash, token) to recover from a bad state; asks first, refuses while a server uses it
  hatch-server update-widgets [NAME... | --all] [--state DIR]   refresh example widgets this instance already uses from the shipped copies (keeps data/, saves changed files as .bak); works while the server runs
  hatch-server url [--state DIR]       print the address to open (no token in it; log in with the token, see below)
  hatch-server code                    print a one-time login code (type it on the login page under "Use a one-time code instead"; valid 5 minutes, single use; needs a running server)
  hatch-server code --revoke           cancel the unused one-time code (also ended by: restart, rotate-token, panic, five wrong attempts)
  hatch-server token [--state DIR]     print the login token, to paste into the login page
  hatch-server sessions                list browser logins (id, created, last seen, client)
  hatch-server logout ID | --all       end one login (the id from \`sessions\`) or all of them
  hatch-server token touch [--state DIR]  record that you changed the token yourself (the page warns when the token is older than 30 days; rotate-token does this by itself)
  hatch-server rotate-token            make a new token, end every login, print the new token once
  hatch-server panic                  emergency: end every login, roll the token, remove the view token, drop a pending one-time code and hosted-page secrets; the new token is not printed (see \`token\`; also: hatch panic)
  hatch-server url --view              print a watch-only URL (makes a separate view token the first time); --revoke-view removes it (view links may go away in a later version)
  hatch-server doctor [--state DIR]    check node, python3, tmux, state dir, server
  hatch-server service [--state DIR] [--port N] [--host H]   print a systemd user unit that starts hatch-server serve (nothing is installed)
  hatch-server --help | --version
  (hatch migrate [DIR] imports a project's .hatch into the per-user instance; run it with hatch)

serve defaults: host 127.0.0.1 (this machine only; the host saved in config.json by an earlier run is kept, and --host 0.0.0.0 or an address such as a Tailscale IP makes it reachable from the network and is remembered), port 7070 (the next free port when that is taken and no --port is given; it is saved in config.json), session derived from the state dir.
state dir: --state DIR, else HATCH_STATE, else ~/.hatch (one instance per user, one token, workspaces for projects). The current directory is never searched: a project-local .hatch is ignored (hatch migrate imports it).
A plain serve|start creates ~/.hatch silently the first time. An explicit --state DIR / HATCH_STATE that points at a missing or invalid dir is confirmed first (--yes creates it without asking; with no terminal to ask on it fails unless --yes is given).
A second instance needs its own --state DIR and --port N.
Put .hatch/ in your .gitignore if you keep one in a project. Open the address, log in at /login with the token (hatch-server token) and the browser keeps a 30-day session cookie. Plain HTTP exposes token and cookie to the network: see docs/SECURITY.md.`;

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o._.push(...argv.slice(i + 1)); break; }
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--version') o.version = true;
    else if (a === '--view-only') o['view-only'] = 'true';
    else if (a === '--tmux-status') o['tmux-status'] = 'true';
    else if (a === '--yes') o.yes = 'true';
    else if (a === '--all') o.all = 'true';
    else if (a === '--view' || a === '--revoke-view' || a === '--once' || a === '--revoke-once' || a === '--revoke') o[a.slice(2)] = 'true';
    else if (a.startsWith('--')) { const [k, v] = a.slice(2).split(/=(.*)/s); o[k] = v ?? argv[++i]; if (o[k] === undefined) fail(`--${k} needs a value`); }
    else o._.push(a);
  }
  return o;
}
// Login administration goes through the running server (the only writer of sessions.json while it runs); null when no server runs.
async function admin(dir, method, route) {
  const { liveOwner } = await import('../src/instance-guard.js');
  if (!liveOwner(dir)) return null;
  const { makeClient } = await import('../src/find.js');
  try { return await makeClient(dir)(method, route); }
  catch (e) { fail(/\b403\b/.test(e.message) ? `the running server is view-only and refuses this. Stop it (\`hatch-server stop\`) and run the command again.` : e.message); }
}
function fail(m, code = 1) { console.error(`hatch-server: ${m}`); process.exit(code); }

// Creating a state dir the user named is a decision: ask (naming the full path) unless --yes; never hang or create silently without a terminal.
// The default ~/.hatch is not asked about: it is where an instance lives, and creating it the first time is the expected thing.
async function confirmStateDir({ dir, explicit }) {
  if (!explicit || isValidStateDir(dir) || o.yes === 'true') return;
  const how = `Pass --yes to create it without asking, or --state DIR to use an existing Hatch state dir.`;
  if (!process.stdin.isTTY || !process.stderr.isTTY) fail(`no valid Hatch state dir at ${dir} (no usable config.json) and no terminal to ask on. ${how}`);
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question(`No Hatch state dir at ${dir}. Create it? [y/N] `)).trim().toLowerCase(); rl.close();
  if (answer !== 'y' && answer !== 'yes') fail(`not creating ${dir}. ${how}`);
}

// A project-local .hatch used to be the instance; now it is ignored. One line, only when the default state dir is in use.
function localHatchHint({ dir, explicit }) {
  const local = path.resolve('.hatch');
  if (explicit || local === dir || !fs.existsSync(local)) return;
  console.error(`hatch-server: ignoring ${shortPath(local)} (instances live in ${shortPath(dir)} now); \`hatch migrate\` imports it as a workspace.`);
}

// `agent` lives in `hatch` (it needs no server); forward without reparsing its flags. Global options can precede the command.
const argv = process.argv.slice(2); const commandPosition = firstCommandIndex(argv);
if (argv[commandPosition] === 'agent') {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./hatch.js', import.meta.url)), ...argv], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const o = parse(process.argv.slice(2));
const cmd = o._[0];
if (o.version) { console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version); process.exit(0); }
if (o.help || !cmd) { console.log(HELP); process.exit(cmd || o.help ? 0 : 1); }

if (['start', 'stop', 'restart', 'status'].includes(cmd)) {
  const d = await import('../src/daemon.js');
  const choice = chooseStateDir({ state: o.state }); const state = choice.dir;
  if (cmd === 'start' || cmd === 'restart') localHatchHint(choice);
  if ((cmd === 'start' || cmd === 'restart') && !d.runningPid(state)) await confirmStateDir(choice);
  const rest = withoutOption(withoutOption(argv.filter((_, i) => i !== commandPosition), 'state'), 'yes');
  try {
    if (cmd === 'status') { const pid = d.runningPid(state); console.log(pid ? `running (pid ${pid}); URL: hatch-server url` : 'not running'); process.exit(pid ? 0 : 1); }
    if (cmd === 'stop') console.log((await d.stop(state)) ? 'stopped' : 'was not running');
    else {
      const r = await (cmd === 'restart' ? d.restart : d.start)(state, path.resolve(process.argv[1]), rest);
      console.log(r.already ? `already running (pid ${r.pid}); use \`hatch-server restart\` to reload code` : r.log.trim());
    }
  } catch (e) { fail(e.message); }
  process.exit(0);
}
if (cmd === 'clear') {
  const dir = chooseStateDir({ state: o.state }).dir;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`no state dir at ${dir}; nothing to clear. Pass --state DIR to choose another.`);
  const d = await import('../src/daemon.js');
  const stop = `Stop it first (\`hatch-server stop --state ${dir}\` or Ctrl+C in its terminal), then run clear again.`;
  const pid = d.runningPid(dir);
  if (pid) fail(`a Hatch server (pid ${pid}) is running on ${dir}. ${stop}`);
  if (isValidStateDir(dir)) { // a foreground server has no pid file: ask the port from config.json
    const { makeClient } = await import('../src/find.js');
    const up = await makeClient(dir)('GET', '/api/health').then(() => true, (e) => e.code !== 2 && !/cannot reach/.test(e.message));
    if (up) fail(`a Hatch server is answering on the port in ${path.join(dir, 'config.json')}. ${stop}`);
  }
  const names = fs.readdirSync(dir).filter((n) => n !== 'allowed-hosts'); // kept: the host names would otherwise be refused after the next start
  if (!names.length) { console.log(`${dir} has nothing to clear`); process.exit(0); }
  if (o.yes !== 'true') {
    if (!process.stdin.isTTY || !process.stderr.isTTY) fail(`no terminal to ask on. Pass --yes to delete everything in ${dir}.`);
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await rl.question(`Delete ALL ${names.length} entries in ${dir} (widgets, notes, trash, token)? [y/N] `)).trim().toLowerCase(); rl.close();
    if (answer !== 'y' && answer !== 'yes') fail(`nothing removed from ${dir}.`);
  }
  for (const n of names) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  console.log(`removed ${names.length} entries from ${dir}: ${names.join(', ')}\nThe next \`hatch-server serve\` creates a fresh state (with a new token and URL).`);
  process.exit(0);
}
if (cmd === 'update-widgets') {
  const dir = chooseStateDir({ state: o.state }).dir;
  if (!isValidStateDir(dir)) fail(`no Hatch state dir at ${dir}. Pass --state DIR to choose another.`);
  const names = o._.slice(1);
  if (!names.length && o.all !== 'true') fail('name the widgets to update (e.g. background-roulette) or pass --all');
  const { updateWidgets } = await import('../src/update-widgets.js');
  let r; try { r = updateWidgets(dir, names.length ? names : null); } catch (e) { fail(e.message); }
  for (const u of r.updated) console.log(`updated ${u.name}: ${u.files.join(', ')}${u.backups.length ? ` (old versions saved as .bak: ${u.backups.join(', ')})` : ''}`);
  if (r.unchanged.length) console.log(`already current: ${r.unchanged.join(', ')}`);
  if (r.missing.length) console.log(`not used in this instance (skipped): ${r.missing.join(', ')}`);
  process.exit(0);
}
if (cmd === 'doctor') { process.exit(printChecks(await doctor({ state: o.state })) ? 0 : 1); }
// One-time login code: issue (default) or cancel. Shared by `code` and the old `url --once|--revoke-once` aliases.
async function oneTimeCode(dir, revoke) {
  if (revoke) {
    const r = await admin(dir, 'DELETE', '/api/auth/once');
    console.log(!r ? 'the server is not running: one-time codes live only in its memory, so none is valid' : r.revoked ? 'one-time code revoked: it no longer works' : 'no unused one-time code was pending');
    process.exit(0);
  }
  const r = await admin(dir, 'POST', '/api/auth/once');
  if (!r) fail('the server is not running: a one-time login code is kept in the running server\'s memory. Start it (`hatch-server start`) and run this again.');
  console.log(r.code);
  console.error(`One-time code: enter it on the login page under "Use a one-time code instead". Valid ${Math.round(r.expiresInSec / 60)} minutes, works once; five wrong attempts cancel it.\nTo cancel it before it is used: \`hatch-server code --revoke\` (restarting the server, \`rotate-token\` and \`panic\` also end it).`);
  process.exit(0);
}
if (cmd === 'code') { await oneTimeCode(findStateDir({ state: o.state }), !!o.revoke); }
if (cmd === 'url') {
  const dir = findStateDir({ state: o.state }); const c = readConfig(dir); const file = path.join(dir, 'config.json');
  const save = (cfg) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(tmp, file); }; // temp + rename: a running server never reads half a file
  if (process.argv.includes('--revoke-view')) { delete c.viewToken; save(c); console.log('view token removed: existing watch-only links stop working'); process.exit(0); }
  if (process.argv.includes('--view')) {
    if (!c.viewToken) { c.viewToken = (await import('node:crypto')).randomBytes(16).toString('hex'); save(c); }
    console.log(`http://${linkHost(c.host)}:${c.port}/?t=${c.viewToken}`); if (isLoopbackHost(c.host)) console.error('Note: the server listens on this machine only, so this link works only here. Start it with --host 0.0.0.0 (or a Tailscale address) for other devices.'); console.log('Watch-only: this link can see the terminal and windows but cannot type, run, or read files.'); process.exit(0);
  }
  if (o.once || o['revoke-once']) { // old spelling: kept as aliases of `code`
    console.error(`Note: \`url ${o.once ? '--once' : '--revoke-once'}\` is replaced by \`hatch-server code${o.once ? '' : ' --revoke'}\` (there is no login link any more).`);
    await oneTimeCode(dir, !!o['revoke-once']);
  }
  console.log(`http://${linkHost(c.host)}:${c.port}/`);
  console.error('Log in with the token (`hatch-server token` prints it) or use `hatch-server code` for a one-time code to type on the login page.');
  process.exit(0);
}
if (cmd === 'token' && o._[1] === 'touch') {
  const { touchTokenStamp } = await import('../src/token.js'); const dir = findStateDir({ state: o.state });
  console.log(`token change recorded: ${touchTokenStamp(dir)} (in ${path.join(dir, 'token-changed')})`); process.exit(0);
}
if (cmd === 'token') { console.log(readConfig(findStateDir({ state: o.state })).token); process.exit(0); }
if (cmd === 'sessions' || cmd === 'logout' || cmd === 'rotate-token' || cmd === 'panic') {
  const dir = findStateDir({ state: o.state });
  const { createSessions } = await import('../src/sessions.js');
  const offline = () => createSessions({ file: path.join(dir, 'sessions.json'), warn: (m) => console.error(`hatch-server: ${m}`) }); // no server running: nobody else writes the file
  const day = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  if (cmd === 'sessions') {
    const list = (await admin(dir, 'GET', '/api/auth/sessions')) ?? offline().list();
    if (!list.length) { console.log('no browser is logged in'); process.exit(0); }
    const rows = [['ID', 'CREATED', 'LAST SEEN', 'EXPIRES', 'CLIENT'], ...list.map((x) => [x.id, day(x.created), day(x.lastSeen), day(x.expires), x.hint || ''])];
    const w = [0, 1, 2, 3].map((c) => Math.max(...rows.map((r) => r[c].length)));
    console.log(rows.map((r) => [...r.slice(0, 4).map((v, c) => v.padEnd(w[c])), r[4]].join('  ')).join('\n')); process.exit(0);
  }
  if (cmd === 'logout') {
    const id = o._[1];
    if (!id && o.all !== 'true') fail('usage: hatch-server logout ID | hatch-server logout --all (ids are shown by `hatch-server sessions`)');
    if (id && !/^[a-f0-9]{4,64}$/.test(id)) fail(`${id} is not a session id: use the ID column of \`hatch-server sessions\` (at least 4 characters)`);
    const route = id ? `/api/auth/sessions/${id}` : '/api/auth/sessions';
    let r = await admin(dir, 'DELETE', route);
    if (!r) { try { const n = id ? offline().revoke(id) : offline().revokeAll(); if (id && !n) fail(`no session with id ${id} (see \`hatch-server sessions\`)`); r = { ended: n }; } catch (e) { fail(e.message); } }
    console.log(`ended ${r.ended} login${r.ended === 1 ? '' : 's'}`); process.exit(0);
  }
  if (cmd === 'panic') { // rotate-token plus: view token removed, pending links dropped. The new token is NOT printed (it may run in a shared terminal or from an agent): `hatch-server token` shows it.
    let r = await admin(dir, 'POST', '/api/auth/panic'); const live = !!r;
    if (!r) { try { const { rotateTokenFile } = await import('../src/token.js'); const view = !!readConfig(dir).viewToken; rotateTokenFile(dir, { dropViewToken: true }); r = { ended: offline().revokeAll(), links: 0, view }; } catch (e) { fail(e.message); } }
    console.log(`PANIC done (${live ? 'server running' : 'server not running, files edited'}): ${r.ended} login${r.ended === 1 ? '' : 's'} ended, token rolled, ${r.view ? 'view token removed' : 'no view token was set'}, ${r.links ? 'pending one-time code dropped, ' : ''}hosted-page secrets cleared.`);
    console.log(`New token is in ${path.join(dir, 'config.json')} (mode 0600); \`hatch-server token\` prints it. \`hatch\` and Claude read it from that file. Open streams close within about 5 seconds.`);
    process.exit(0);
  }
  let r = await admin(dir, 'POST', '/api/auth/rotate-token');
  if (!r) { try { const { rotateTokenFile } = await import('../src/token.js'); r = { token: rotateTokenFile(dir), ended: offline().revokeAll() }; } catch (e) { fail(e.message); } }
  console.log(r.token);
  console.error(`New token written to ${path.join(dir, 'config.json')} (mode 0600); ${r.ended} login${r.ended === 1 ? '' : 's'} ended. Every browser must log in again; \`hatch\` and Claude pick the new token up from that file. A watch-only link is not affected (\`url --revoke-view\`).`);
  process.exit(0);
}
if (cmd === 'service') {
  const exe = path.resolve(process.argv[1]); const choice = chooseStateDir({ state: o.state }); const state = choice.dir; const wd = path.dirname(state);
  // systemd: % and $ are special even inside quotes (written %% and $$); quotes and backslashes are escaped with a backslash
  const q = (x) => { const e = x.replace(/%/g, '%%').replace(/\$/g, '$$$$'); return /^[\w@+=:,./%$-]+$/.test(e) ? e : `"${e.replace(/(["\\])/g, '\\$1')}"`; };
  const args = ['serve', ...(choice.explicit ? ['--state', state] : []), ...(o.port ? ['--port', String(o.port)] : []), ...(o.host ? ['--host', o.host] : [])];
  console.log(`# ~/.config/systemd/user/hatch.service
[Unit]
Description=Hatch: browser terminal and panels
After=network.target

[Service]
WorkingDirectory=${q(wd)}
ExecStart=${q(process.execPath)} ${q(exe)} ${args.map(q).join(' ')}
Environment=PATH=${process.env.PATH}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
#
# Install:  save the lines above as ~/.config/systemd/user/hatch.service, then
#   systemctl --user daemon-reload && systemctl --user enable --now hatch
#   loginctl enable-linger $USER      # keep it running when you are logged out
# The tmux session survives restarts of the service; the URL with the token is in ${path.join(state, 'config.json')}
# (or: hatch-server url --state ${q(state)}).`);
  process.exit(0);
}
if (cmd !== 'serve') fail(`unknown command ${cmd}. Try \`hatch-server --help\`.`);

const explicitPort = o.port !== undefined;
const port = explicitPort ? Number(o.port) : DEFAULT_PORT;
if (!Number.isInteger(port) || port < 0 || port > 65535) fail('--port must be a number between 0 and 65535');
const choice = chooseStateDir({ state: o.state }); const stateDir = choice.dir;
localHatchHint(choice);
{ // before anything is created or written: a live server owns this state dir
  const { liveOwner, OwnerError } = await import('../src/instance-guard.js');
  const owner = liveOwner(stateDir); if (owner) fail(new OwnerError(stateDir, owner).message);
}
await confirmStateDir(choice);
// --host, else the host an earlier run saved in config.json (so upgrading changes nothing), else this machine only
const savedHost = (() => { try { const h = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8')).host; return typeof h === 'string' && h ? h : undefined; } catch { return undefined; } })();
const host = o.host || savedHost || '127.0.0.1';
let hatch;
try { hatch = createHatch({ tmuxStatus: o['tmux-status'] === 'true', viewOnly: o['view-only'] === 'true' || process.argv.includes('--view-only'), root: o.root, stateDir, host, port, session: o.session, cwd: path.resolve(o.cwd || process.cwd()) }); }
catch (e) { fail(['EACCES', 'EROFS', 'EPERM', 'ENOENT'].includes(e.code) ? `cannot create the state dir ${stateDir} (${e.code}). Run hatch-server in a writable directory or pass --state DIR.` : e.message); }
let actual;
try { const r = await listenFromPort(hatch, port, { explicit: explicitPort }); actual = r.port; if (r.moved) console.log(`Port ${port} is in use (another Hatch?), so this instance uses ${actual} and saved it in ${path.join(stateDir, 'config.json')}; hatch commands run from here find it there.`); }
catch (e) {
  fail(e.code === 'EOWNED' ? e.message : e.code === 'EADDRINUSE' ? (explicitPort ? `port ${port} is in use. Pick another with --port N (is hatch-server already running?)` : `ports ${port} to ${port + 49} are all in use. Pick one with --port N.`) : e.message);
}
// Installed before the "is running" line below: whoever waits for that line may signal at once, and a signal that arrives
// before the handler exists kills the process without releasing server.lock.
const { createStop, installCrashHandlers } = await import('../src/shutdown.js');
installCrashHandlers();
const stop = createStop(() => hatch.close());
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const shown = linkHost(host);
console.log(`Hatch ${hatch.config.session ? '' : ''}is running (tmux session "${hatch.session}", state ${stateDir})`);
console.log(`\n  http://${shown}:${actual}/\n`);
console.log('Log in with the token: `hatch-server token` prints it (paste it at /login), `hatch-server code` makes a one-time login code.');
console.log(isLoopbackHost(host) ? `Listening on ${host} only: reachable from this machine, not from the network. Use --host 0.0.0.0 (or a Tailscale address) to allow other devices.`
  : `Listening on ${host === '0.0.0.0' || host === '::' ? 'all interfaces' : host} over plain HTTP: anyone on this network who learns the token can run commands on this box, and the token and login cookie can be read on the wire. Use --host 127.0.0.1 with Tailscale or an HTTPS reverse proxy (docs/SECURITY.md).`);
if (hatch.viewOnly) console.log('VIEW-ONLY: this page mirrors the terminal and panels; it cannot type, run, read files or change anything.');
if (o.root) console.log(`File access (browser, editor, downloads, uploads) is confined to ${path.resolve(o.root)}. Terminal, run and widget commands are NOT confined.`);
console.log('Inside tmux, Claude can drive the page with `hatch` (see README). Ctrl+C stops the server; the tmux session keeps running.');
