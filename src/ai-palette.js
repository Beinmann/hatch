// Natural-language palette: a sentence becomes a short list of `hatch` commands, which the user confirms before anything runs.
// The model is not trusted. Every command it proposes, and every command the page later asks to run, goes through
// `validateCommand` (an allowlist of subcommands and flags below), and commands are run as argument arrays without a shell.
// Anything that runs arbitrary code (run, every, watch, cmd, host, term --cmd, tasks --run, widget generate/new/add/rm) is not on the list.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EFFECTS } from './fx.js';
import { extractJson } from './claude-p.js';
import { AiError } from './ai.js';

export const MAX_SENTENCE = 500;
const MAX_COMMANDS = 6;
const MAX_ARGS = 30;
const MAX_ARG_LEN = 2000;
const HATCH_BIN = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));

// first word -> allowed second words (null: any arguments are fine, they are data). `usage` also feeds the model's prompt.
const COMMANDS = {
  widget: { sub: ['open', 'close', 'list', 'examples', 'boards', 'reload'], usage: 'widget open NAME [--dir PATH] | widget close NAME | widget list | widget examples | widget boards | widget reload NAME   (NAME: cpu, git, top, sysinfo, log-tail, board, ... from `widget examples`; `widget open git --dir PATH` is the git window for PATH)' },
  popup: { sub: ['open', 'list', 'close'], usage: 'popup open progress|files|note|NAME | popup list | popup close NAME|ID' },
  note: { sub: null, usage: 'note "markdown" [--title T]   (a small note window)' },
  image: { sub: null, usage: 'image PATH [--title T]' },
  open: { sub: null, usage: 'open FILE|DIR|URL [--title T]' },
  files: { sub: null, usage: 'files [DIR]   (file browser)' },
  edit: { sub: null, usage: 'edit FILE[:LINE]   (text editor window)' },
  panels: { sub: null, usage: 'panels   (list open windows)' },
  close: { sub: null, usage: 'close ID   (close one window; ID from `panels`)' },
  git: { sub: null, usage: 'git [DIR]   (git status window)' },
  progress: { sub: ['show', 'open', 'plan', 'step'], usage: 'progress open | progress show | progress plan "STEP" "STEP" ... | progress step "TITLE" pending|running|done|blocked' },
  fx: { sub: null, usage: `fx NAME|off [--intensity 0-100]   (background effect; NAME: ${EFFECTS.join(' ')})` },
  set: { sub: ['transparency', 'window-transparency', 'background-mode'], usage: 'set transparency 0..100 | set window-transparency 0..100|default|follow | set background-mode fill|fit|stretch|center|tile' },
  grep: { sub: null, usage: 'grep PATTERN [DIR]   (search results window)' },
  diff: { sub: null, usage: 'diff [GIT-ARGS...]   (git diff window)' },
  log: { sub: null, usage: 'log [GIT-ARGS...]   (recent commits window)' },
  ports: { sub: null, usage: 'ports   (listening ports)' },
  notify: { sub: null, usage: 'notify "text" [--level info|warn|done]' },
  folder: { sub: ['list', 'new', 'add', 'remove', 'rename'], usage: 'folder list | folder new NAME [WINDOW...] | folder add NAME WINDOW... | folder remove WINDOW... | folder rename OLD NEW' },
  workspace: { sub: ['list', 'new'], usage: 'workspace list | workspace new NAME' },
  desktop: { sub: null, usage: 'desktop   (open a set of live gadgets)' },
};
// flags that turn an otherwise harmless command into code execution or skip a safety prompt
const FORBIDDEN_FLAGS = new Set(['--cmd', '--run', '--yes', '--confirm', '--wait', '--state', '--url']);

/** `[argv...]` (without the leading `hatch`) -> `{ ok: true, argv, text }` or `{ ok: false, reason }`. */
export function validateCommand(argv) {
  if (!Array.isArray(argv) || !argv.length) return { ok: false, reason: 'empty command' };
  if (argv.length > MAX_ARGS || !argv.every((a) => typeof a === 'string' && a.length <= MAX_ARG_LEN && !/[\x00-\x08\x0b-\x1f\x7f]/.test(a))) return { ok: false, reason: 'arguments must be plain text (at most 30, 2000 characters each)' };
  const args = argv[0] === 'hatch' ? argv.slice(1) : argv;
  const [name, second] = args;
  if (!name || !Object.prototype.hasOwnProperty.call(COMMANDS, name)) return { ok: false, reason: `\`${name || ''}\` is not a command the palette may run` };
  const spec = COMMANDS[name];
  if (spec.sub && !spec.sub.includes(second)) return { ok: false, reason: `\`hatch ${name} ${second ?? ''}\` is not allowed (allowed: ${spec.sub.join(', ')})`.replace(' )', ')') };
  const bad = args.find((a) => FORBIDDEN_FLAGS.has(a.split('=')[0]));
  if (bad) return { ok: false, reason: `the flag ${bad} is not allowed` };
  if (args.some((a, i) => i > 0 && a === '-')) return { ok: false, reason: 'reading from stdin is not allowed' };
  const q = (a) => (/^[\w@%+=:,./~-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  return { ok: true, argv: args, text: `hatch ${args.map(q).join(' ')}` };
}

/** Model reply (parsed JSON) -> { commands: [{ argv, text }], rejected: [{ text, reason }], say }. Never throws on bad commands, only on a reply with no list. */
export function normalizePlan(parsed) {
  if (!parsed || !Array.isArray(parsed.commands)) throw new AiError('The model did not return a command list. Try rephrasing.', 502);
  const commands = []; const rejected = [];
  for (const c of parsed.commands.slice(0, MAX_COMMANDS + 4)) {
    const v = validateCommand(c);
    if (v.ok && commands.length < MAX_COMMANDS) commands.push({ argv: v.argv, text: v.text });
    else rejected.push({ text: Array.isArray(c) ? `hatch ${c.filter((x) => typeof x === 'string').join(' ')}`.slice(0, 200) : String(c).slice(0, 200), reason: v.ok ? `at most ${MAX_COMMANDS} commands` : v.reason });
  }
  return { commands, rejected, say: typeof parsed.say === 'string' ? parsed.say.trim().slice(0, 300) : '' };
}

export const promptFor = (sentence, cwd) => [
  'Turn the request into `hatch` commands for the Hatch browser terminal (a tool that opens windows and widgets next to a terminal).',
  'Use only these commands (the first word after `hatch`):', ...Object.values(COMMANDS).map((c) => `- ${c.usage}`),
  `The server folder (the default for "this dir"/"here") is: ${cwd}. Use absolute paths; there is no shell, so no ~, no $VARS, no pipes.`,
  'Reply with JSON only: {"commands":[["widget","open","git"],["fx","rain","--intensity","30"]],"say":"one short sentence of what this does"}. Each command is an array of arguments WITHOUT the word hatch. At most 6 commands. If the request cannot be done with these commands, reply {"commands":[],"say":"why"}.',
  '', `Request: ${JSON.stringify(sentence)}`,
].join('\n');

/** Runs validated commands one after the other (stops at the first failure). `ws` is the page's current workspace. Returns [{ text, code, out }]. */
export async function runCommands(list, { cwd, stateDir, ws, timeoutMs = 20000 }) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_COMMANDS) throw new AiError(`run between 1 and ${MAX_COMMANDS} commands`);
  const checked = list.map((a) => validateCommand(a));
  const bad = checked.find((c) => !c.ok); if (bad) throw new AiError(`refused: ${bad.reason}`, 403);
  const env = { ...process.env, HATCH_STATE: stateDir }; delete env.HATCH_URL; delete env.HATCH_WORKSPACE;
  if (typeof ws === 'string' && /^[\w-]{1,32}$/.test(ws)) env.HATCH_WORKSPACE = ws;
  const out = [];
  for (const c of checked) {
    const r = await new Promise((resolve) => execFile(process.execPath, [HATCH_BIN, ...c.argv], { cwd, env, timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(err ? stderr || stdout || err.message : stdout).trim().slice(0, 500) })));
    out.push({ text: c.text, ...r });
    if (r.code !== 0) break;
  }
  return out;
}

/** The `palette` AI task: only the typed sentence is sent. Returns a plan to confirm; nothing runs here. */
export async function planPalette(ai, body, cwd) {
  const sentence = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!sentence) throw new AiError('type what you want after the ?');
  if (sentence.length > MAX_SENTENCE) throw new AiError(`keep the request under ${MAX_SENTENCE} characters`);
  const s = await ai.ready();
  const parsed = extractJson(await ai.ask(promptFor(sentence, cwd), s));
  if (parsed === undefined) throw new AiError('The model did not return JSON. Try rephrasing.', 502);
  return normalizePlan(parsed);
}
