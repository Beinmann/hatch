// Which window gets focus when the focused one closes: the most recently focused window that is still open
// and visible, else null (the caller then focuses the terminal). `history` is ids, most recent first.
export function touch(history, id) {
  return [id, ...history.filter((h) => h !== id)];
}

export function pickAfterClose(history, closedId, isOpenAndShown) {
  return history.find((id) => id !== closedId && isOpenAndShown(id)) ?? null;
}
