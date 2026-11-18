// Header chip: how many agents are running. Hatch has no agent registry; the signal it does have is progress plans
// (the unnamed one plus one per named plan, usually one per agent or task) whose steps agents mark running or blocked.
// So: an agent is "running" when its plan has a running step, "blocked" when it has a blocked step and nothing running.
// Pure counting lives here so it can be tested without a DOM.

/** plans: iterable of { steps: [{ status }] }. Returns { running, blocked }. */
export function countAgents(plans) {
  let running = 0; let blocked = 0;
  for (const p of plans) {
    const steps = Array.isArray(p?.steps) ? p.steps : [];
    if (steps.some((s) => s?.status === 'running')) running++;
    else if (steps.some((s) => s?.status === 'blocked')) blocked++;
  }
  return { running, blocked };
}

/** Text, state class and accessible label for the chip. */
export function agentChipView({ running, blocked }) {
  const text = blocked ? `${running} running, ${blocked} blocked` : `${running} running`;
  const state = blocked ? 'warn' : running ? 'ok' : 'idle';
  const noun = (n) => `${n} agent${n === 1 ? '' : 's'}`;
  const label = running || blocked
    ? `${noun(running)} running${blocked ? `, ${noun(blocked)} blocked` : ''}; click to open progress`
    : 'No agents running; click to open progress';
  return { text, state, label };
}
