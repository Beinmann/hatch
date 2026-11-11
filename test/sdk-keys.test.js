import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs public/sdk.js against a minimal fake window to check which keys it forwards to the host page.
function sandbox() {
  const listeners = {}; const posted = []; const parent = { postMessage: (m) => posted.push(m) };
  const win = {
    parent, addEventListener: (t, f) => (listeners[t] ||= []).push(f), document: { createElement: () => ({}), documentElement: { style: { setProperty() {} }, prepend() {} } },
  };
  win.window = win; win.self = win; win.focus = () => {};
  vm.runInNewContext(fs.readFileSync(new URL('../public/sdk.js', import.meta.url), 'utf8'), win);
  const key = (o) => { let stopped = false; const e = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, preventDefault() { stopped = true; }, stopPropagation() {}, ...o }; for (const f of listeners.keydown) f(e); return stopped; };
  const message = (m) => { for (const f of listeners.message) f({ source: parent, data: m }); };
  return { key, message, posted, blur: () => listeners.blur.forEach((f) => f()) };
}
const LEADER = { ctrl: true, alt: false, shift: false, meta: false, code: 'Space' };

test('SDK forwards Ctrl+Shift+G and the leader chord, but not the removed Ctrl+Shift chords', () => {
  const s = sandbox(); s.message({ type: 'init', leader: LEADER });
  assert.ok(s.key({ code: 'KeyG', key: 'G', ctrlKey: true, shiftKey: true }));
  assert.ok(s.key({ code: 'KeyP', key: 'P', ctrlKey: true, shiftKey: true }));
  assert.ok(s.key({ code: 'Space', key: ' ', ctrlKey: true }));
  assert.ok(s.key({ code: 'KeyP', key: 'p', ctrlKey: true }), 'Ctrl+P opens the palette');
  s.message({ type: 'hatch-leader', armed: false }); // the host disarmed it
  for (const code of ['KeyX', 'KeyM', 'KeyH', 'Period']) assert.ok(!s.key({ code, key: code, ctrlKey: true, shiftKey: true }), code);
  assert.ok(!s.key({ code: 'KeyH', key: 'h' }), 'plain keys stay in the widget');
  assert.deepEqual(s.posted.filter((m) => m.type === 'hatch-shortcut').map((m) => m.code), ['KeyG', 'KeyP', 'Space', 'KeyP']);
});

test('after the leader chord the SDK forwards the next keys until the host says it is disarmed', () => {
  const s = sandbox(); s.message({ type: 'init', leader: LEADER });
  s.key({ code: 'Space', key: ' ', ctrlKey: true });
  assert.ok(s.key({ code: 'KeyH', key: 'h' }));
  s.message({ type: 'hatch-leader', armed: false });
  assert.ok(!s.key({ code: 'KeyH', key: 'h' }), 'typing works again once disarmed');
  assert.deepEqual(s.posted.filter((m) => m.type === 'hatch-shortcut').map((m) => m.code), ['Space', 'KeyH']);
  assert.equal(s.posted.filter((m) => m.type === 'hatch-shortcut')[1].type, 'hatch-shortcut');
});

test('without a leader in init, or after blur, nothing is forwarded', () => {
  const s = sandbox(); s.message({ type: 'init' });
  assert.ok(!s.key({ code: 'Space', key: ' ', ctrlKey: true }));
  s.message({ type: 'init', leader: LEADER }); s.key({ code: 'Space', key: ' ', ctrlKey: true }); s.blur();
  assert.ok(!s.key({ code: 'KeyH', key: 'h' }));
});

test('SDK asks the host for init on start and takes window focus when told to', () => {
  const s = sandbox();
  assert.ok(s.posted.some((m) => m.type === 'hatch-hello'), 'a widget that missed init can get it again');
  assert.doesNotThrow(() => s.message({ type: 'hatch-take-focus' }));
});
