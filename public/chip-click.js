// What a click on a window's taskbar chip does (Windows-like): a minimized window is restored and focused, the
// window that has focus (on screen) is minimized, anything else is brought to the front and focused.
export function chipClickAction({ minimized, onScreen, focused }) {
  if (minimized) return 'restore';
  return onScreen && focused ? 'minimize' : 'focus';
}
