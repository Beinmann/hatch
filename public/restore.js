// Which minimized popup Leader u brings back: floating windows of the shown workspace (or sticky ones),
// most recently minimized first. `order` maps panel id -> a rising counter set when it was minimized;
// windows minimized before this page loaded have no entry and come last, in list order.
export function pickRestore(panels, order, workspace) {
  const cands = panels.filter((p) => p.minimized && p.placement === 'float' && (p.sticky || (p.ws || 'main') === workspace));
  cands.sort((a, b) => (order.get(b.id) ?? -1) - (order.get(a.id) ?? -1));
  return cands[0] || null;
}
