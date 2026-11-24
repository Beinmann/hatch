// Pure helpers for the files panel image preview (kept free of DOM imports so they can be unit tested).
export const IMG = /\.(png|jpe?g|gif|webp|svg)$/i;
export const PREVIEW_DELAY = 100; // ms to wait after the selection settles before fetching the image

export const isImageName = (name) => IMG.test(name || '');
export const previewUrl = (fullPath) => `/api/file?path=${encodeURIComponent(fullPath)}`; // same route the image panel uses

// The path to preview for a selected row name in a listing, or null (folders, text files, '..', unknown names).
export function previewTarget(dir, entries, name) {
  const e = (entries || []).find((x) => x.name === name);
  if (!e || e.type !== 'file' || !isImageName(e.name)) return null;
  return dir === '/' ? `/${e.name}` : `${dir}/${e.name}`;
}

/** Ctrl+H in a Files window shows or hides dotfiles. Plain Ctrl+H only (Shift/Alt/Meta combinations stay free). */
export const isHiddenToggleKey = (e) => !!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.code === 'KeyH' || String(e.key).toLowerCase() === 'h');
