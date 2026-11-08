import test from 'node:test';
import assert from 'node:assert/strict';
import { appendOutput, retainedText, outputTail, KEEP_OUTPUT } from '../src/run-output.js';
import { startHatch, waitFor, readSse } from './helpers.js';

const buffer = () => ({ chunks: [], bytes: 0, state: 'running', truncated: false });

test('retained output trims only excess bytes and never starts inside UTF-8', () => {
  const output = buffer(); appendOutput(output, Buffer.from('abcdefghijklmnopqrstuvwxyz'), 10);
  assert.equal(Buffer.concat(output.chunks).toString(), 'qrstuvwxyz'); assert.equal(output.bytes, 10); assert.equal(output.chunks[0].length, 10); assert.equal(output.truncated, true);
  const sample = Buffer.from('abcdef🙂TAIL');
  for (let split = 0; split <= sample.length; split++) {
    const out = buffer(); appendOutput(out, sample.subarray(0, split), 7); appendOutput(out, sample.subarray(split), 7);
    assert.equal(Buffer.concat(out.chunks).toString(), 'TAIL', `split ${split}`); assert.equal(out.bytes, 4); assert.ok(out.bytes <= 7);
  }
});

test('running output snapshots avoid incomplete trailing characters and tails count complete code points', () => {
  const output = buffer(); const sample = Buffer.from('ready🙂'); appendOutput(output, sample.subarray(0, -2));
  assert.equal(retainedText(output), 'ready'); appendOutput(output, sample.subarray(-2)); assert.equal(retainedText(output), 'ready🙂');
  assert.equal(outputTail('prefix🙂', 1), '...(truncated)...\n🙂'); assert.equal(outputTail('x🙂y', 2), '...(truncated)...\n🙂y');
  assert.equal(outputTail('🙂', 1), '🙂'); assert.equal(outputTail('', 1), '');
  for (const max of [-1, 0, 1.5, NaN, Infinity, null, '10']) assert.throws(() => outputTail('text', max), error => error.status === 400);
  assert.equal(outputTail('short', Number.MAX_SAFE_INTEGER), 'short');
  const capped = outputTail('x'.repeat(1048580), 2000000); assert.equal(capped.length, '...(truncated)...\n'.length + 1048576);
  const bom = buffer(); appendOutput(bom, Buffer.from('\ufefftext')); assert.equal(retainedText(bom), '\ufefftext');
});

test('output API validates limits and preserves a multibyte final character', async () => {
  const h = await startHatch();
  try {
    const run = (await h.call('POST', '/api/runs', { cmd: "printf 'prefix🙂'" })).data;
    await waitFor(async () => (await h.call('GET', `/api/runs/${run.id}`)).data.state === 'done');
    const route = `/api/runs/${run.id}/output`;
    assert.equal((await h.call('GET', `${route}?max=1`)).data, '...(truncated)...\n🙂');
    for (const max of ['-1', '0', '1.5', 'NaN', 'Infinity', '', 'bad']) {
      const result = await h.call('GET', `${route}?max=${max}`); assert.equal(result.status, 400, max); assert.match(result.data.error, /positive integer/);
    }
    assert.equal((await h.call('GET', `${route}?max=999999999`)).data, 'prefix🙂');
  } finally { await h.close(); }
});

test('late output streams announce discarded history and replay a bounded UTF-8 tail', async () => {
  const h = await startHatch();
  try {
    const run = (await h.call('POST', '/api/runs', { cmd: 'python3 -c "import sys;sys.stdout.write(\'x\'*600000+\'🙂\')"' })).data;
    await waitFor(async () => (await h.call('GET', `/api/runs/${run.id}`)).data.state === 'done');
    const events = await readSse(`${h.base}/api/runs/${run.id}/stream`, { 'x-token': h.hatch.token }, list => list.some(event => event.event === 'exit'));
    assert.equal(events.find(event => event.event === 'truncated')?.data, 'true');
    const replay = Buffer.from(events.find(event => event.event === 'replay').data, 'base64'); assert.ok(replay.length <= KEEP_OUTPUT);
    assert.ok(replay.toString().endsWith('🙂')); assert.ok(!replay.toString().includes('\ufffd'));
    assert.equal((await h.call('GET', `/api/runs/${run.id}/output?max=1`)).data, '...(truncated)...\n🙂');
  } finally { await h.close(); }
});
