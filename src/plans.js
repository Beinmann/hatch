// Named progress plans: several plans side by side (one per agent or task), each with its own window.
// A plan is one readable file, progress/plans/NAME.json: { "diagram": "...mermaid...", "steps": [ ... ] }.
// The unnamed plan keeps living in progress/steps.json and progress/diagram.mmd exactly as before ("default").
// Hand edits work: the state dir watcher calls scan(); a malformed file warns and keeps the last good plan.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeSteps, applyStepPatch, applyStepUpdate } from './progress.js';

export const DEFAULT_PLAN = 'default'; // what a plan name of "" or "default" means
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

/** deps: dir (progress/plans), emit(event, data), warn(file, message|null), write(file, text) atomic, defaultPlan() -> { diagram, steps } */
export function createPlans({ dir, emit, warn, write, defaultPlan }) {
  const plans = new Map(); // name -> { diagram, steps }; sigs: name -> JSON
  const sigs = new Map();
  const file = (name) => path.join(dir, `${name}.json`);

  function scan() {
    const seen = new Set();
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!f.endsWith('.json')) continue;
      const name = f.slice(0, -5); const rel = `progress/plans/${f}`;
      if (!NAME.test(name) || name === DEFAULT_PLAN) { warn(rel, `plan names are letters, digits, - and _ (at most 48), and "${DEFAULT_PLAN}" is reserved for the unnamed plan`); continue; }
      seen.add(name);
      try {
        const v = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('a plan file must be a JSON object { "diagram": "...", "steps": [...] }');
        if (v.diagram !== undefined && typeof v.diagram !== 'string') throw new Error('diagram must be text');
        const plan = { diagram: v.diagram || '', steps: normalizeSteps(v.steps ?? []) };
        warn(rel, null);
        const sig = JSON.stringify(plan);
        if (sigs.get(name) !== sig) { sigs.set(name, sig); plans.set(name, plan); emit('plan', { name, ...plan }); }
      } catch (e) { warn(rel, e instanceof SyntaxError ? `invalid JSON: ${e.message}` : e.message); }
    }
    for (const name of [...plans.keys()]) if (!seen.has(name)) { plans.delete(name); sigs.delete(name); warn(`progress/plans/${name}.json`, null); emit('plan', { name, removed: true }); }
  }

  const named = () => [...plans.keys()].sort();
  const isEmpty = (p) => !p.steps.length && !p.diagram.trim();
  /** Plans that exist: the unnamed one counts once it has content. */
  function names() { const d = defaultPlan(); return [...(isEmpty(d) ? [] : [DEFAULT_PLAN]), ...named()]; }

  /** Which plan a command addresses: the given name, or the only one, or the unnamed one when none exist.
   *  Returns '' for the unnamed plan. Two or more plans and no name is an error that lists them, never a guess. */
  function resolve(name) {
    if (name !== undefined && name !== null && name !== '') {
      if (name === DEFAULT_PLAN) return '';
      if (!NAME.test(String(name))) fail(400, `plan name "${name}" is not valid: use letters, digits, - and _ (at most 48)`);
      return String(name);
    }
    const all = names();
    if (all.length <= 1) return all[0] === undefined || all[0] === DEFAULT_PLAN ? '' : all[0];
    return fail(409, `${all.length} progress plans exist (${all.join(', ')}): say which one with --plan NAME or export HATCH_PLAN=NAME`);
  }

  const get = (name) => plans.get(name) || { diagram: '', steps: [] };
  function save(name, plan) {
    fs.mkdirSync(dir, { recursive: true });
    const created = !plans.has(name);
    write(file(name), `${JSON.stringify({ diagram: plan.diagram, steps: plan.steps }, null, 2)}\n`);
    scan();
    return created;
  }
  // Each write returns { created } so the server can open the plan's window the first time.
  const setSteps = (name, steps) => ({ created: save(name, { ...get(name), steps: normalizeSteps(steps, { updated: new Date().toISOString() }) }) });
  const setDiagram = (name, diagram) => ({ created: save(name, { ...get(name), diagram: String(diagram) }) });
  function patchStep(name, id, body, restyle = (d) => d) {
    const { steps, step } = applyStepPatch(get(name).steps, id, body);
    const created = save(name, { steps, diagram: restyle(get(name).diagram, id, step.status) });
    return { step, created };
  }
  function updateStep(name, stepName, body, restyle = (d) => d) {
    const { steps, step } = applyStepUpdate(get(name).steps, stepName, body);
    const created = save(name, { steps, diagram: restyle(get(name).diagram, step.id, step.status) });
    return { step, created };
  }
  function remove(name) {
    if (!plans.has(name)) fail(404, `no progress plan ${name}; plans: ${names().join(', ') || 'none'}`);
    fs.rmSync(file(name), { force: true }); scan();
  }
  return { scan, names, resolve, get, setSteps, setDiagram, patchStep, updateStep, remove, all: () => Object.fromEntries(plans) };
}
