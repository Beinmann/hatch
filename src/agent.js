// Persistent project instructions make progress part of an agent's normal workflow.
// Only our marked block is replaced; the project's own instructions remain byte-for-byte intact.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './state.js';

const BEGIN = '<!-- hatch:begin -->';
const END = '<!-- hatch:end -->';
export const agentInstructions = () => fs.readFileSync(new URL('../docs/claude-snippet.md', import.meta.url), 'utf8').trim();

export function integrateInstructions(original, instructions = agentInstructions()) {
  const block = `${BEGIN}\n## Hatch browser workspace\n\n${instructions}\n${END}`;
  const starts = original.split(BEGIN).length - 1;
  const ends = original.split(END).length - 1;
  if (!starts && !ends) return `${original}${original && !original.endsWith('\n') ? '\n' : ''}${original ? '\n' : ''}${block}\n`;
  if (starts !== 1 || ends !== 1 || original.indexOf(END) < original.indexOf(BEGIN)) {
    throw new Error('Hatch instruction markers are incomplete or duplicated; repair the hatch:begin / hatch:end block before trying again');
  }
  const start = original.indexOf(BEGIN); const end = original.indexOf(END) + END.length;
  return original.slice(0, start) + block + original.slice(end);
}

export function installAgentInstructions({ dir = process.cwd(), target = 'both' } = {}) {
  const names = target === 'both' ? ['CLAUDE.md', 'AGENTS.md'] : target === 'claude' ? ['CLAUDE.md'] : target === 'codex' ? ['AGENTS.md'] : null;
  if (!names) throw new Error('--target must be claude, codex or both');
  const root = path.resolve(dir);
  if (!fs.statSync(root).isDirectory()) throw new Error(`not a directory: ${root}`);
  // Read and validate all destinations before writing any of them.
  const edits = names.map((name) => {
    const file = path.join(root, name);
    let original = '';
    try {
      if (!fs.lstatSync(file).isFile()) throw new Error(`${file} is not a regular file; update it manually`);
      original = fs.readFileSync(file, 'utf8');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { file, original, updated: integrateInstructions(original) };
  });
  return edits.map(({ file, original, updated }) => {
    const changed = original !== updated;
    if (changed) atomicWrite(file, updated);
    return { file, changed };
  });
}
