// One progress model for HTTP updates and hand-edited files. Validate the whole plan before replacing good data.
export const STEP_STATUS = ['todo', 'running', 'done', 'blocked', 'skipped'];
const invalid = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
export const stepSlug = (title) => String(title).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'step';
export const findStep = (steps, name) => steps.find((s) => s.id === name) || steps.find((s) => s.title.toLowerCase() === String(name).toLowerCase());

export function unusedStepId(steps, title) {
  const base = stepSlug(title); const used = new Set(steps.map((s) => s.id));
  let id = base; let suffix = 2;
  while (used.has(id)) id = `${base}_${suffix++}`;
  return id;
}

export function normalizeSteps(steps, { updated = null } = {}) {
  if (!Array.isArray(steps)) invalid('steps must be a JSON array of {id,title,status}');
  const ids = new Set();
  return steps.map((step, i) => {
    const label = `step ${i + 1}`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) invalid(`${label} must be an object`);
    const rawId = step.id ?? step.title; const rawTitle = step.title ?? step.id;
    const text = (value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
    if (!text(rawId) || !String(rawId).trim() || /[\x00-\x1f\x7f]/.test(String(rawId))) invalid(`${label} needs a non-empty id or title without control characters`);
    if (!text(rawTitle) || !String(rawTitle).trim()) invalid(`${label} needs a non-empty title`);
    const id = String(rawId); const title = String(rawTitle);
    if (ids.has(id)) invalid(`duplicate step id ${JSON.stringify(id)}`);
    ids.add(id);
    const status = step.status === undefined ? 'todo' : step.status;
    if (!STEP_STATUS.includes(status)) invalid(`${label}: status must be one of ${STEP_STATUS.join(', ')}`);
    const when = step.updated === undefined || step.updated === null || step.updated === '' ? updated : step.updated;
    if (when !== null && !((typeof when === 'string' || typeof when === 'number') && Number.isFinite(new Date(when).getTime()))) invalid(`${label}: updated must be a valid timestamp`);
    const result = { id, title, status, updated: when };
    for (const key of ['detail', 'group']) {
      if (step[key] !== undefined) {
        if (typeof step[key] !== 'string') invalid(`${label}: ${key} must be text`);
        result[key] = step[key];
      }
    }
    return result;
  });
}
