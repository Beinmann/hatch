import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pickEditor, vimRequest } from '../src/editor.js';
import { startHatch, tmp } from './helpers.js';

test('pickEditor: auto means vim when installed, builtin or a missing binary means the textarea', () => {
  const has = (b) => (['vim', 'nvim'].includes(b) ? `/usr/bin/${b}` : null);
  assert.equal(pickEditor(undefined, has), 'vim');
  assert.equal(pickEditor('auto', has), 'vim');
  assert.equal(pickEditor('nvim', has), 'nvim');
  assert.equal(pickEditor('builtin', has), null);
  assert.equal(pickEditor('emacs', has), null);
  assert.equal(pickEditor('vim', () => null), null);
});

test('vimRequest turns text-file editor requests into terminal windows and leaves the rest alone', () => {
  const yes = () => true;
  const r = vimRequest({ type: 'editor', props: { path: "/tmp/it's a file.txt", line: 7 } }, 'vim', yes);
  assert.equal(r.type, 'terminal');
  assert.match(r.props.name, /^vim-it_s_a_file_txt-[0-9a-f]{6}$/);
  assert.equal(r.props.cmd, `vim +7 -- '/tmp/it'\\''s a file.txt'`);
  assert.deepEqual(vimRequest({ type: 'editor', props: { path: '/tmp/a' } }, 'vim', yes).props.name, vimRequest({ type: 'editor', props: { path: '/tmp/a' } }, 'vim', yes).props.name);
  const ed = { type: 'editor', props: { path: '/tmp/a' } };
  assert.equal(vimRequest(ed, null, yes), ed);                                   // no vim
  assert.equal(vimRequest(ed, 'vim', () => false), ed);                          // binary or missing file
  assert.equal(vimRequest({ ...ed, builtin: true }, 'vim', yes).type, 'editor'); // explicit opt-out
  const img = { type: 'image', props: { src: '/tmp/a.png' } };
  assert.equal(vimRequest(img, 'vim', yes), img);
  const rel = { type: 'editor', props: { path: 'rel.txt' } };
  assert.equal(vimRequest(rel, 'vim', yes), rel);
});

test('POST /api/panels opens vim for text files only when the editor config allows it', async () => {
  const h = await startHatch({ findBin: (b) => (b === 'vim' ? '/usr/bin/vim' : null) });
  try {
    const txt = path.join(h.dir, 'n.txt'); fs.writeFileSync(txt, 'hello\n');
    const bin = path.join(h.dir, 'b.bin'); fs.writeFileSync(bin, Buffer.from([1, 0, 2]));
    const a = await h.call('POST', '/api/panels', { type: 'editor', props: { path: txt, line: 2 } });
    assert.equal(a.data.type, 'terminal'); assert.match(a.data.props.cmd, /^vim \+2 -- /);
    assert.equal((await h.call('POST', '/api/panels', { type: 'editor', props: { path: bin } })).data.type, 'editor');
    assert.equal((await h.call('POST', '/api/panels', { type: 'editor', props: { path: path.join(h.dir, 'missing') } })).data.type, 'editor');
    const cfg = path.join(h.stateDir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), editor: 'builtin' }));
    assert.equal((await h.call('POST', '/api/panels', { type: 'editor', props: { path: txt } })).data.type, 'editor');
  } finally { await h.close(); }
});

test('GET /api/pterm/NAME/alive is false once the window program ended, so the window can close instead of restarting it', async () => {
  const h = await startHatch();
  try {
    assert.equal((await h.call('GET', '/api/pterm/nothere/alive')).data.alive, false);
  } finally { await h.close(); }
});
