// Replacing the login token in config.json (read-modify-write: other settings such as viewToken and allowedHosts stay).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite } from './state.js';

/** Writes a fresh 128-bit token (file mode 0600) and returns it. Throws when config.json cannot be read as a JSON object. */
export function rotateTokenFile(stateDir) {
  const file = path.join(stateDir, 'config.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`cannot read ${file}: ${e.message}`); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${file} must hold a JSON object`);
  const token = crypto.randomBytes(16).toString('hex');
  atomicWrite(file, `${JSON.stringify({ ...cfg, token }, null, 2)}\n`, { mode: 0o600 });
  return token;
}
