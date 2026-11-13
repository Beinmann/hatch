// The file a window is showing, for the title-bar "path" button. A widget bound to a file names it in widget.json
// (`file`); a widget that switches files itself (a board that opens a child board) reports the current one with
// hatch.setPath(). The reported value wins. Anything that is not a plain one-line string is ignored.
export function shownPath(reported, meta) {
  for (const v of [reported, meta?.file]) if (typeof v === 'string' && v && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v)) return v;
  return null;
}
