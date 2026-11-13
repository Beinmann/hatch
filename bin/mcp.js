#!/usr/bin/env node
// Hatch as an MCP server (stdio, newline-delimited JSON-RPC 2.0): the same actions as `hatch`, as typed tools.
// Register with:  claude mcp add hatch -- node /path/to/hatch/bin/mcp.js     (uses HATCH_STATE, else ~/.hatch)
// Zero dependencies; it only speaks to the local Hatch HTTP API with the token from the state dir.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { findStateDir, makeClient, CliError } from '../src/find.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// Which progress plan a tool call addresses: its `plan` argument, else $HATCH_PLAN of this process, else none (the server then
// uses the only plan, or refuses when several exist and says how to choose).
const PLAN = { plan: { type: 'string', description: 'Progress plan name (letters, digits, - and _); created on first use. Optional with 0 or 1 plans; required when several plans exist unless HATCH_PLAN is set.' } };
const pq = (a) => { const n = a.plan || process.env.HATCH_PLAN; return n ? `?plan=${encodeURIComponent(n)}` : ''; };
const str = (description) => ({ type: 'string', description });

const TOOLS = [
  { name: 'hatch_progress_set', description: 'Update an optional Mermaid diagram alongside the step journey. This does not open or focus a popup. Use hatch_progress_plan for granular work and hatch_progress_open to show details.',
    inputSchema: { type: 'object', properties: { ...PLAN, diagram: str('Mermaid source, e.g. "flowchart LR\\n  plan --> code --> test"') }, required: ['diagram'] },
    run: async (api, a) => { await api('PUT', `/api/progress/diagram${pq(a)}`, String(a.diagram)); return 'progress diagram updated'; } },
  { name: 'hatch_progress_step', description: 'Update a granular progress step, its current detail or group (creates it when new). Use before starting work, after verifying a step and when blocked. Does not open a popup or steal focus.',
    inputSchema: { type: 'object', properties: { ...PLAN, name: str('Step id or title'), detail: str('Current finding, action, verification or blocker'), group: str('Optional phase or group'), status: { type: 'string', enum: ['todo', 'running', 'done', 'blocked', 'skipped'] } }, required: ['name', 'status'] },
    run: async (api, a) => {
      const step = await api('POST', `/api/progress/steps${pq(a)}`, { name: a.name, status: a.status, ...(a.detail !== undefined && { detail: a.detail }), ...(a.group !== undefined && { group: a.group }) });
      return `${step.title}: ${step.status}`;
    } },
  { name: 'hatch_progress_get', description: 'Read the current plan and optional diagram as JSON. Read this before replacing a plan so manual user updates are preserved.',
    inputSchema: { type: 'object', properties: { ...PLAN } }, run: async (api, a) => JSON.stringify(await api('GET', `/api/progress${pq(a)}`), null, 2) },
  { name: 'hatch_progress_plan', description: 'Replace the plan with small concrete steps in work order. Read the existing plan first; preserve completed work and manual edits when revising it.',
    inputSchema: { type: 'object', properties: { ...PLAN, steps: { type: 'array', items: { type: 'object', properties: { id: str('Stable step id'), title: str('Concrete action'), status: { type: 'string', enum: ['todo', 'running', 'done', 'blocked', 'skipped'] }, detail: str('Current detail or blocker'), group: str('Optional phase') }, required: ['id', 'title'] } } }, required: ['steps'] },
    run: async (api, a) => { await api('PUT', `/api/progress/steps${pq(a)}`, a.steps); return 'progress plan updated'; } },
  { name: 'hatch_progress_open', description: 'Open or restore progress details explicitly. Progress updates themselves leave the user keyboard focus alone.',
    inputSchema: { type: 'object', properties: { ...PLAN } }, run: async (api, a) => { const n = a.plan || process.env.HATCH_PLAN; const p = await api('POST', '/api/panels', { type: 'progress', title: n || 'Progress', placement: 'float', ...(n && n !== 'default' && { props: { plan: n } }) }); return `progress open as ${p.id}`; } },
  { name: 'hatch_note', description: 'Show a short markdown note in a window in the user\'s browser.',
    inputSchema: { type: 'object', properties: { markdown: str('Note text (markdown)'), title: str('Window title') }, required: ['markdown'] },
    run: async (api, a) => { const p = await api('POST', '/api/panels', { type: 'note', title: a.title || 'Note', props: { markdown: String(a.markdown) }, w: 360, h: 240 }); return `note open as ${p.id}`; } },
  { name: 'hatch_image', description: 'Show an image file (PNG, JPEG, GIF, WebP, SVG) from this box in a window in the user\'s browser.',
    inputSchema: { type: 'object', properties: { path: str('Path to the image on this box'), title: str('Window title') }, required: ['path'] },
    run: async (api, a) => { const abs = path.resolve(String(a.path)); if (!fs.existsSync(abs)) throw new Error(`no such file: ${abs}`); const p = await api('POST', '/api/panels', { type: 'image', title: a.title || path.basename(abs), props: { src: abs } }); return `image open as ${p.id}`; } },
  { name: 'hatch_notify', description: 'Notify the user (toast, and a desktop notification if the tab is hidden). Use when blocked or finished.',
    inputSchema: { type: 'object', properties: { text: str('Message'), level: { type: 'string', enum: ['info', 'warn', 'done'] } }, required: ['text'] },
    run: async (api, a) => { await api('POST', '/api/notify', { text: String(a.text), level: a.level || 'info' }); return 'notified'; } },
  { name: 'hatch_ask', description: 'Ask the user a question in a browser dialog and wait for the answer. Returns the chosen choice or the typed text.',
    inputSchema: { type: 'object', properties: { question: str('The question'), choices: { type: 'array', items: { type: 'string' }, description: 'Buttons; default Yes and No' }, free_text: { type: 'boolean', description: 'Show a text box instead of buttons' }, timeout_seconds: { type: 'number', description: 'Give up after this positive number of seconds (default 600)' } }, required: ['question'] },
    run: async (api, a) => {
      const timeout = a.timeout_seconds === undefined ? 600 : a.timeout_seconds;
      if (typeof timeout !== 'number' || !Number.isFinite(timeout * 1000) || timeout <= 0) throw new Error('timeout_seconds must be a positive finite number');
      const { id } = await api('POST', '/api/ask', { question: a.question, choices: a.choices, freeText: a.free_text === undefined ? false : a.free_text });
      const until = Date.now() + timeout * 1000;
      for (;;) {
        const r = await api('GET', `/api/ask/${id}`); if (r.answered) return r.answer;
        if (Date.now() > until) { await api('DELETE', `/api/ask/${id}`).catch(() => {}); throw new Error('the user did not answer before the timeout'); }
        await new Promise((res) => setTimeout(res, 400));
      }
    } },
  { name: 'hatch_run', description: 'Run a shell command in its own live output window in the user\'s browser. With wait=true, waits for it to end and returns the exit code plus the last part of its output.',
    inputSchema: { type: 'object', properties: { command: str('Shell command'), cwd: str('Working directory (absolute)'), wait: { type: 'boolean' }, timeout_seconds: { type: 'number', description: 'With wait: give up waiting after this long (default 600); the command keeps running' } }, required: ['command'] },
    run: async (api, a) => {
      const r = await api('POST', '/api/runs', { cmd: String(a.command), cwd: a.cwd });
      await api('POST', '/api/panels', { type: 'output', title: String(a.command).slice(0, 40), props: { cmd: String(a.command), runId: r.id, cwd: a.cwd }, w: 560, h: 300 });
      if (!a.wait) return `running as ${r.id}`;
      const until = Date.now() + (Number(a.timeout_seconds) || 600) * 1000;
      for (;;) { const v = await api('GET', `/api/runs/${r.id}`); if (v.state === 'done') { const out = (await api('GET', `/api/runs/${r.id}/output?max=6000`, undefined, { raw: true })).trim(); return `exit code ${v.code}${out ? `\n--- output (last part) ---\n${out}` : ''}`; } if (Date.now() > until) return `still running after the timeout (run ${r.id}); it keeps going in its window`; await new Promise((res) => setTimeout(res, 400)); }
    } },
  { name: 'hatch_open_widget', description: 'Open an existing widget (a directory widgets/NAME with index.html in the state dir) as a window. Create widgets by writing their files first.',
    inputSchema: { type: 'object', properties: { name: str('Widget name'), dock: { type: 'boolean', description: 'Open in the dock instead of as a floating window' } }, required: ['name'] },
    run: async (api, a) => { const p = await api('POST', '/api/panels', { type: 'widget', props: { name: String(a.name) }, ...(a.dock ? { placement: 'dock' } : {}) }); return `widget ${a.name} open as ${p.id}`; } },
  { name: 'hatch_report', description: 'A markdown summary of the session: progress steps, runs with exit codes, open windows. Useful to hand work over or to recall the state.',
    inputSchema: { type: 'object', properties: {} }, run: async (api) => api('GET', '/api/report', undefined, { raw: true }) },
  { name: 'hatch_copy', description: 'Put text on the clipboard of the user\'s browser.',
    inputSchema: { type: 'object', properties: { text: str('Text to copy') }, required: ['text'] },
    run: async (api, a) => { const r = await api('POST', '/api/copy', { text: String(a.text) }); return `sent ${r.bytes} bytes`; } },
];

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const fail = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);

let api = null;
function client() {
  if (!api) {
    const raw = makeClient(findStateDir({}));
    // windows opened from a workspace's terminal belong to that workspace ($HATCH_WORKSPACE, as for the hatch CLI)
    const ws = process.env.HATCH_WORKSPACE;
    api = (m, r, b, x) => raw(m, r, ws && m === 'POST' && r === '/api/panels' && b ? { ...b, ws } : b, x);
  }
  return api;
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled, ...) need no answer
  if (method === 'initialize') return reply(id, { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hatch', version: VERSION } });
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return fail(id, -32602, `unknown tool ${params?.name}`);
    try { const text = await tool.run(client(), params.arguments || {}); return reply(id, { content: [{ type: 'text', text: String(text) }] }); }
    catch (e) { return reply(id, { content: [{ type: 'text', text: e instanceof CliError || e instanceof Error ? e.message : String(e) }], isError: true }); }
  }
  return fail(id, -32601, `method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0)); // the client left: stop polling and exit
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'parse error'); }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail(null, -32600, 'invalid request');
  handle(msg).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, e.message); });
});
