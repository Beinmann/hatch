import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHatch } from './helpers.js';

const widgetMeta = (sources) => ({ files: { 'index.html': 'x' }, meta: { sources } });

test('hatch.call: runs an exec source once with the argument in $HATCH_ARG; {{widget}} names the folder', async () => {
  const h = await startHatch();
  try {
    await h.call('PUT', '/api/widgets/callw', widgetMeta([
      { name: 'echo', kind: 'exec', json: true, cmd: 'printf \'{"arg":"%s","widget":"%s"}\' "$HATCH_ARG" {{widget}}' },
      { name: 'noarg', kind: 'exec', cmd: 'echo "[${HATCH_ARG-unset}]"' },
      { name: 'slow', kind: 'exec', cmd: 'sleep 5', timeoutMs: 500 },
      { name: 'tail', kind: 'tail', path: '/dev/null' },
    ]));
    const r = await h.call('POST', '/api/call', { widget: 'callw', source: 'echo', arg: 'a b-1.jpg' });
    assert.equal(r.status, 200); assert.deepEqual(r.data.value.json, { arg: 'a b-1.jpg', widget: 'callw' });
    assert.equal((await h.call('POST', '/api/call', { widget: 'callw', source: 'noarg' })).data.value.out, '[unset]', 'no arg means no variable');
    assert.match((await h.call('POST', '/api/call', { widget: 'callw', source: 'slow' })).data.value.error, /timed out/);
    // nothing is left running: a call does not subscribe
    assert.equal(h.hatch.sources.active(), 0);
  } finally { await h.close(); }
});

test('hatch.call: bad arguments, unknown or non-exec sources and view-only links are refused with a reason', async () => {
  const h = await startHatch();
  try {
    await h.call('PUT', '/api/widgets/callw', widgetMeta([
      { name: 'echo', kind: 'exec', cmd: 'echo "$HATCH_ARG"' }, { name: 'tail', kind: 'tail', path: '/dev/null' },
    ]));
    for (const arg of ['../x', 'a/b', '.hidden', 'a;id', 'a$(id)', 'a\nb', '', 'x'.repeat(201), 7, null, ['a']]) {
      const r = await h.call('POST', '/api/call', { widget: 'callw', source: 'echo', arg });
      assert.equal(r.status, 400, `arg ${JSON.stringify(arg)}`); assert.match(r.data.error, /file-name-like/);
    }
    assert.equal((await h.call('POST', '/api/call', { widget: 'callw', source: 'echo', arg: 'ok_1.jpg' })).status, 200);
    assert.equal((await h.call('POST', '/api/call', { widget: 'callw', source: 'nope' })).status, 404);
    assert.equal((await h.call('POST', '/api/call', { widget: 'missing', source: 'echo' })).status, 404);
    assert.equal((await h.call('POST', '/api/call', { widget: 'callw' })).status, 400);
    const t = await h.call('POST', '/api/call', { widget: 'callw', source: 'tail' });
    assert.equal(t.status, 400); assert.match(t.data.error, /only runs exec sources/);
    // a view token may watch but must not run commands that change things
    const file = path.join(h.stateDir, 'config.json'); const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.viewToken = 'viewer-token-for-call-check'; fs.writeFileSync(file, JSON.stringify(config));
    const view = await fetch(`${h.base}/api/call`, { method: 'POST', headers: { 'x-token': 'viewer-token-for-call-check', 'content-type': 'application/json' }, body: JSON.stringify({ widget: 'callw', source: 'echo' }) });
    assert.equal(view.status, 403);
  } finally { await h.close(); }
});

// ---- the background-roulette example, with stub `hatch` and `curl` so nothing touches the network or the real page ----
function stubBin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-stub-'));
  fs.writeFileSync(path.join(dir, 'hatch'), '#!/bin/sh\necho "$@" >> "$(dirname "$0")/hatch.log"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'curl'), `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -D) D=$2; shift;; -o) O=$2; shift;; http*) U=$1;; esac; shift; done
case "$U" in
  */info) printf '{"id":"7","author":"Test Author","url":"https://example.invalid/p/7"}';;
  *) [ -e "$(dirname "$0")/offline" ] && exit 6; printf 'HTTP/2 200\\r\\npicsum-id: 7\\r\\n\\r\\n' > "$D"; printf 'JPEGDATA' > "$O";;
esac
`, { mode: 0o755 });
  return dir;
}

test('background-roulette example: download keeps id + sidecar, pick sets the page background, delete removes both files', async () => {
  const bin = stubBin(); const oldPath = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  const h = await startHatch();
  try {
    assert.equal((await h.call('POST', '/api/examples/background-roulette/open', {})).status, 200);
    const call = async (source, arg) => (await h.call('POST', '/api/call', { widget: 'background-roulette', source, ...(arg !== undefined && { arg }) }));
    const images = path.join(h.stateDir, 'widgets', 'background-roulette', 'data');

    // offline: a clear message, nothing saved
    fs.writeFileSync(path.join(bin, 'offline'), '');
    let r = await call('dl'); assert.equal(r.status, 200); assert.match(r.data.value.error, /download failed/); assert.deepEqual(fs.readdirSync(images), []);
    fs.rmSync(path.join(bin, 'offline'));

    r = await call('dl');
    assert.equal(r.data.value.error, undefined, r.data.value.error);
    const list = r.data.value.json; assert.equal(list.length, 1);
    assert.match(list[0].n, /^7-\d+\.jpg$/); assert.equal(list[0].m.id, '7'); assert.equal(list[0].m.info.author, 'Test Author');
    assert.equal(list[0].m.width, 2560); assert.equal(fs.existsSync(path.join(images, list[0].n.replace(/\.jpg$/, '.json'))), true);
    const log = () => fs.readFileSync(path.join(bin, 'hatch.log'), 'utf8').trim().split('\n');
    assert.match(log().at(-1), new RegExp(`^set background .*${list[0].n} --state `), 'the download became the page background');

    // an older image without a sidecar still lists, with m null
    fs.writeFileSync(path.join(images, '1-1.jpg'), 'x'); fs.utimesSync(path.join(images, '1-1.jpg'), 1, 1);
    r = await call('gallery'); assert.deepEqual(r.data.value.json.map((e) => [e.n === list[0].n, e.m === null]), [[true, false], [false, true]]);

    // pick: only existing .jpg files of this widget
    assert.equal((await call('pick', '1-1.jpg')).data.value.json.set, '1-1.jpg'); assert.match(log().at(-1), /^set background .*1-1\.jpg --state /);
    const before = log().length;
    for (const arg of ['nope.jpg', 'secret.txt']) assert.notEqual((await call('pick', arg)).data.value.code, 0, arg);
    assert.equal(log().length, before, 'a refused pick does not touch the background');

    // delete: image and sidecar go, the other image stays; a wrong name deletes nothing
    assert.notEqual((await call('del', 'nope.jpg')).data.value.code, 0);
    r = await call('del', list[0].n);
    assert.deepEqual(r.data.value.json.map((e) => e.n), ['1-1.jpg']); assert.deepEqual(fs.readdirSync(images).sort(), ['1-1.jpg']);
  } finally { process.env.PATH = oldPath; await h.close(); fs.rmSync(bin, { recursive: true, force: true }); }
});
