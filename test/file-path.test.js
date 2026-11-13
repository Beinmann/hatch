import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shownPath } from '../public/file-path.js';
import { boardFileMeta } from '../src/board-file.js';

test('shownPath: reported path wins, else the file in widget.json, junk is ignored', () => {
  assert.equal(shownPath(null, { file: '/p/a.board.json' }), '/p/a.board.json');
  assert.equal(shownPath('/p/child.board.json', { file: '/p/a.board.json' }), '/p/child.board.json');
  assert.equal(shownPath('bad\npath', { file: '/p/a.board.json' }), '/p/a.board.json');
  assert.equal(shownPath(null, {}), null);
  assert.equal(shownPath(undefined, undefined), null);
});

test('a board bound to a file records that file in widget.json for the path button', () => {
  assert.equal(boardFileMeta({ sources: [] }, '/p/plan.board.json').file, '/p/plan.board.json');
});
