// Converting a window into another type: a small table of supported pairs, not a general converter.
// The shared content model is markdown text: a note is markdown, progress steps map to a checklist, and a widget made
// from a note keeps its source in note.md so it can come back.
import fs from 'node:fs';
import path from 'node:path';
import { stepSlug } from './progress.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/; // same rule as state.js (not imported: state.js imports this file)
const TARGET_ALIAS = { diagram: 'progress' };
export const CONVERSIONS = { note: ['progress', 'widget'], progress: ['note'], widget: ['note'] };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function normalizeTarget(to) { return TARGET_ALIAS[to] || to; }

/** Throws a 400 saying which types the source can become. */
export function checkConversion(from, to) {
  const possible = CONVERSIONS[from] || [];
  if (!possible.includes(to)) {
    const hint = possible.length ? `a ${from} window can become: ${possible.join(', ')} (diagram = progress)` : `a ${from} window cannot be converted; only ${Object.keys(CONVERSIONS).join(', ')} windows can`;
    throw Object.assign(new Error(`cannot convert ${from} to ${to || '(missing --to)'}: ${hint}`), { status: 400 });
  }
}

/** Markdown checklist items -> steps. */
export function checklistToSteps(markdown) {
  const steps = []; let fenced = false;
  for (const line of String(markdown).split('\n')) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    const m = !fenced && /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.+?)\s*$/.exec(line);
    if (m) steps.push({ title: m[2], status: m[1] === ' ' ? 'todo' : 'done' });
  }
  const used = new Set();
  return steps.map((s) => { let id = stepSlug(s.title); const base = id; for (let n = 2; used.has(id); n++) id = `${base}_${n}`; used.add(id); return { ...s, id }; });
}

export function stepsToMarkdown(progress) {
  const lines = progress.steps.map((s) => `- [${s.status === 'done' ? 'x' : ' '}] ${s.title}${s.status === 'done' || s.status === 'todo' ? '' : ` (${s.status})`}`);
  let md = lines.join('\n') || '(no steps yet)';
  if (progress.diagram.trim()) md += `\n\n\`\`\`mermaid\n${progress.diagram.trim()}\n\`\`\``;
  return `${md}\n`;
}

export function widgetHtml(markdown) {
  return `<!doctype html><meta charset="utf-8"><title>note</title>\n<style>body{font:14px/1.5 system-ui,sans-serif;margin:12px;color:var(--fg,inherit)}pre{white-space:pre-wrap;margin:0;font:inherit}</style>\n<pre>${esc(markdown)}</pre>\n`;
}

/** Picks a widget name from the window title that is not taken yet. */
export function freeWidgetName(widgetsDir, title) {
  const base = (stepSlug(title).replace(/_/g, '-').slice(0, 40) || 'note');
  let name = NAME_RE.test(base) ? base : 'note';
  for (let n = 2; fs.existsSync(path.join(widgetsDir, name)); n++) name = `${base}-${n}`;
  return name;
}
