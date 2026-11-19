// The header's "more options" menu: which entries it holds and how arrow keys move through them (pure, so it can be tested).
// Workspace entries live here because the header only shows workspace chips once there are two or more.

/** Entries in order; a null is a separator. `id` is the DOM id of the entry's button, `action` names what app.js runs. */
export function moreMenuItems({ workspaces = 1, viewOnly = false, shortcuts = {} } = {}) {
  const items = [];
  if (!viewOnly) items.push({ id: 'palbtn', label: 'Commands', hint: shortcuts.palette || 'Ctrl+P', action: 'palette' });
  items.push({ id: 'progressbtn', label: 'Progress', hint: shortcuts.progress || 'Ctrl+Shift+G', action: 'progress' });
  items.push({ id: 'setbtn', label: 'Settings', hint: '', action: 'settings' });
  if (!viewOnly) {
    items.push(null);
    items.push({ id: 'wsnewbtn', label: 'New workspace', hint: '', action: 'ws-new' });
    if (workspaces >= 2) items.push({ id: 'wsswitchbtn', label: 'Switch workspace', hint: '', action: 'ws-switch' });
    items.push({ id: 'wsrenamebtn', label: 'Rename workspace', hint: '', action: 'ws-rename' });
  }
  return items;
}

/** The workspace chips and the "+" button show only with two or more workspaces (one is managed from the menu). */
export const showWorkspaceChips = (workspaces) => workspaces >= 2;

/** Index of the entry to focus after an arrow/Home/End key (wraps around); -1 for any other key. `count` = number of entries. */
export function menuFocusIndex(key, current, count) {
  if (!count) return -1;
  if (key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % count;
  if (key === 'ArrowUp') return current < 0 ? count - 1 : (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return -1;
}
