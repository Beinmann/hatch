// Small inline SVG icons for the taskbar and window title bars, one per window type (no libraries, no network). They use currentColor.
const P = {
  terminal: '<path d="M2.5 4.5l3.5 3.5-3.5 3.5M8 12h5.5"/>',
  git: '<circle cx="4" cy="3.2" r="1.7"/><circle cx="4" cy="12.8" r="1.7"/><circle cx="12" cy="5.2" r="1.7"/><path d="M4 4.9v6.2M12 6.9c0 2.6-2 3.7-8 4.4"/>',
  files: '<path d="M2 4.5V12a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5H3a1 1 0 00-1 1z"/>',
  'files-preview': '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3"/>',
  note: '<path d="M3.5 2.5h9v11h-9z"/><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3"/>',
  editor: '<path d="M6 4L2.5 8 6 12M10 4l3.5 4L10 12"/>',
  output: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M4.5 6.5h5M4.5 9h3"/>',
  progress: '<path d="M2 13V9M6 13V6M10 13V8M14 13V3"/>',
  iframe: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11"/>',
  page: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11"/>',
  widget: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
  network: '<path d="M3 5.5h10M10.5 3L13 5.5 10.5 8M13 10.5H3M5.5 8L3 10.5 5.5 13"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 4.5V8l2.5 1.5"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  folder: '<path d="M2 4.5V12a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5H3a1 1 0 00-1 1z"/>',
  window: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/>',
};

// Returns an <svg> element for a window type (a generic window icon for unknown types).
export function chipIcon(type) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('class', 'cico'); s.setAttribute('aria-hidden', 'true');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.4');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = P[type] || P.window;
  return s;
}

// A widget panel has the type `widget`; which widget it is lives in props.name (e.g. git, git-<project>, ports). Names here map to an icon (and with it the
// window-type hue in the page styles) only where a matching icon exists; every other widget keeps the generic one.
const WIDGET_ICON = { git: 'git', ports: 'network', clock: 'clock', 'analog-clock': 'clock', timer: 'clock', pomodoro: 'clock', files: 'files', 'log-tail': 'output', cpu: 'progress', top: 'progress', sysinfo: 'progress', graph: 'progress' };
/** The icon/hue key of a panel: its type, or for a widget panel the key its widget name maps to ("git-app" -> git), else "widget". */
export function iconKey(panel) {
  if (panel?.type !== 'widget') return panel?.type;
  const name = String(panel.props?.name ?? '').toLowerCase();
  if (WIDGET_ICON[name]) return WIDGET_ICON[name];
  return name.startsWith('git-') ? 'git' : 'widget'; // git-<project> style names
}
