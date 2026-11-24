// "Upload" button for phones: a file picker, because a phone has no drag and its screenshots are in the gallery, not the clipboard.
// Pure parts here (testable without a browser); app.js wires them to the same upload functions paste and drop use.

/** True on touch-first devices: the primary pointer is coarse (a finger) and nothing hovers. A narrow desktop window
 *  does not qualify (it has a mouse and can drag), a tablet does. mm is window.matchMedia. */
export function isTouchFirst(mm) {
  try { return !!(mm && (mm('(pointer: coarse)').matches && mm('(hover: none)').matches)); } catch { return false; }
}

/** Send each picked file through the paste/drop path: images get the image treatment, other files are uploaded as they are. */
export function uploadPicked(files, { uploadImage, uploadFile }) {
  const list = [...(files || [])];
  for (const f of list) (String(f.type || '').startsWith('image/') ? uploadImage(f, f.name) : uploadFile(f));
  return list.length;
}
