import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pendingAsks, waitFor, startHatch, readSse } from './helpers.js';

const MCP = fileURLToPath(new URL('../bin/mcp.js', import.meta.url));

/** Talks JSON-RPC to the MCP server over stdio. */
function connect(state) {
  const p = spawn('node', [MCP], { env: { ...process.env, HATCH_STATE: state } });
  let buf = ''; const waiting = new Map(); let n = 0;
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(line); waiting.get(m.id)?.(m); } });
  const call = (method, params) => new Promise((res) => { const id = ++n; waiting.set(id, res); p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  return { call, notify: (method) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`), close: () => p.kill() };
}

test('MCP: initialize, list tools, call tools against a real server', async () => {
  const h = await startHatch(); const c = connect(h.stateDir);
  try {
    const init = await c.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'hatch'); assert.equal(init.result.protocolVersion, '2025-03-26'); assert.ok(init.result.capabilities.tools);
    c.notify('notifications/initialized');
    const list = (await c.call('tools/list')).result.tools; assert.ok(list.length >= 10);
    assert.ok(list.every((t) => t.name.startsWith('hatch_') && t.inputSchema.type === 'object' && t.description));
    const got = readSse(`${h.base}/api/events`, { 'x-token': h.hatch.token }, (e) => e.some((x) => x.event === 'notify'), 5000);
    await new Promise((r) => setTimeout(r, 200));
    const note = await c.call('tools/call', { name: 'hatch_notify', arguments: { text: 'from mcp', level: 'done' } });
    assert.equal(note.result.isError, undefined); assert.match((await got).find((x) => x.event === 'notify').data, /from mcp/);
    assert.match((await c.call('tools/call', { name: 'hatch_note', arguments: { markdown: '# hi', title: 'N' } })).result.content[0].text, /note open as p1/);
    await c.call('tools/call', { name: 'hatch_progress_set', arguments: { diagram: 'flowchart LR\n  a --> b\n' } });
    assert.equal((await h.call('GET', '/api/panels')).data.some(p => p.type === 'progress'), false, 'diagram updates do not open popups');
    await c.call('tools/call', { name: 'hatch_progress_plan', arguments: { steps: [{ id: 'a', title: 'Inspect', detail: 'Read the layout', group: 'Discovery' }] } });
    await c.call('tools/call', { name: 'hatch_progress_step', arguments: { name: 'a', status: 'running', detail: 'Trace popup focus' } });
    const plan = JSON.parse((await c.call('tools/call', { name: 'hatch_progress_get', arguments: {} })).result.content[0].text);
    assert.equal(plan.steps[0].detail, 'Trace popup focus'); assert.equal(plan.steps[0].group, 'Discovery');
    await c.call('tools/call', { name: 'hatch_progress_open', arguments: {} });
    await h.call('PATCH', '/api/panels/progress', { w: 777, h: 444 });
    await c.call('tools/call', { name: 'hatch_progress_open', arguments: {} });
    assert.equal((await h.call('GET', '/api/panels/progress')).data.w, 777);
    assert.match((await h.call('GET', '/api/progress')).data.diagram, /class a running/);
    const run = await c.call('tools/call', { name: 'hatch_run', arguments: { command: 'exit 2', wait: true } });
    assert.match(run.result.content[0].text, /exit code 2/);
    const echoed = await c.call('tools/call', { name: 'hatch_run', arguments: { command: 'echo mcp-sees-this; exit 0', wait: true } }); assert.match(echoed.result.content[0].text, /exit code 0[\s\S]*mcp-sees-this/);
    assert.match((await c.call('tools/call', { name: 'hatch_report', arguments: {} })).result.content[0].text, /# Hatch session report/);
    const invalidTimeout = await c.call('tools/call', { name: 'hatch_ask', arguments: { question: 'Must not appear', timeout_seconds: -1 } });
    assert.equal(invalidTimeout.result.isError, true); assert.deepEqual(await pendingAsks(h), []);
    const pending = c.call('tools/call', { name: 'hatch_ask', arguments: { question: 'Go?', choices: ['Yes', 'No'] } });
    const question = await waitFor(async () => (await pendingAsks(h)).find(item => item.question === 'Go?')); await h.call('POST', `/api/ask/${question.id}/answer`, { answer: 'No' });
    assert.equal((await pending).result.content[0].text, 'No');
    const bad = await c.call('tools/call', { name: 'hatch_image', arguments: { path: '/nonexistent.png' } }); assert.equal(bad.result.isError, true); assert.match(bad.result.content[0].text, /no such file/);
    assert.equal((await c.call('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
    assert.equal((await c.call('bogus')).error.code, -32601);
    assert.deepEqual((await c.call('ping')).result, {});
  } finally { c.close(); await h.close(); }
});
