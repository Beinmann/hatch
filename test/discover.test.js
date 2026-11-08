import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { tasks, ports } from '../src/discover.js';
import { startHatch, tmp } from './helpers.js';

test('tasks: package.json scripts (with the right package manager) and Makefile targets', () => {
  const d = tmp();
  assert.deepEqual(tasks(d), []);
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', build: 'tsc' } }));
  fs.writeFileSync(path.join(d, 'Makefile'), 'CC := gcc\n.PHONY: all\nall: main.o\n\tcc\nclean:\n\trm -f *.o\nclean:\n');
  const t = tasks(d); assert.deepEqual(t.map((x) => x.cmd), ['npm run test', 'npm run build', 'make all', 'make clean']);
  fs.writeFileSync(path.join(d, 'pnpm-lock.yaml'), ''); assert.equal(tasks(d)[0].cmd, 'pnpm run test');
  fs.writeFileSync(path.join(d, 'package.json'), '{nope'); assert.deepEqual(tasks(d).map((x) => x.cmd), ['make all', 'make clean']);
});

test('ports: parses fake /proc/net/tcp for LISTEN sockets and maps the owning process', () => {
  const root = tmp(); fs.mkdirSync(path.join(root, 'net'));
  fs.writeFileSync(path.join(root, 'net/tcp'), '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1\n   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4343 1\n   2: 0100007F:C000 0100007F:0BB8 01 00000000:00000000 00:00000000 00000000  1000        0 5555 1\n');
  fs.writeFileSync(path.join(root, 'net/tcp6'), '  sl  local_address                         remote_address                        st tx_queue rx_queue\n   0: 00000000000000000000000001000000:1771 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4444 1\n');
  fs.mkdirSync(path.join(root, '777/fd'), { recursive: true }); fs.writeFileSync(path.join(root, '777/comm'), 'node\n'); fs.symlinkSync('socket:[4242]', path.join(root, '777/fd/3'));
  const p = ports(root);
  assert.deepEqual(p.map((x) => x.port), [3000, 6001, 8080]);
  assert.equal(p[0].process, 'node'); assert.equal(p[0].scope, 'localhost only'); assert.equal(p[2].scope, 'all interfaces'); assert.equal(p[1].process, null);
  assert.deepEqual(ports(path.join(root, 'missing')), []);
});

test('ports API sees a real listener, tasks API reads the server dir', async () => {
  const srv = net.createServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const h = await startHatch();
  try {
    fs.writeFileSync(path.join(h.dir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
    assert.ok((await h.call('GET', '/api/ports')).data.some((x) => x.port === port), 'finds our listener');
    assert.ok(!(await h.call('GET', '/api/ports')).data.some((x) => x.port === h.port), 'does not list Hatch itself');
    assert.equal((await h.call('GET', '/api/tasks')).data[0].cmd, 'npm run lint');
  } finally { await h.close(); await new Promise((r) => srv.close(r)); }
});

test('files: git ls-files (tracked + untracked, ignored left out) and a bounded walk outside git', async () => {
  const { files } = await import('../src/discover.js'); const { spawnSync } = await import('node:child_process');
  const d = tmp(); fs.mkdirSync(path.join(d, 'src')); fs.mkdirSync(path.join(d, 'node_modules')); fs.writeFileSync(path.join(d, 'src', 'a.js'), '1'); fs.writeFileSync(path.join(d, 'b.md'), '2'); fs.writeFileSync(path.join(d, 'node_modules', 'x.js'), '3');
  const plain = files(d).sort(); assert.deepEqual(plain, ['b.md', 'src/a.js'], 'the walk skips node_modules');
  if (spawnSync('git', ['--version']).status === 0) {
    spawnSync('git', ['init', '-q'], { cwd: d }); fs.writeFileSync(path.join(d, '.gitignore'), 'ignored.txt\n'); fs.writeFileSync(path.join(d, 'ignored.txt'), 'x'); fs.writeFileSync(path.join(d, 'new.txt'), 'x');
    const g = files(d).sort(); assert.ok(g.includes('src/a.js') && g.includes('new.txt') && !g.includes('ignored.txt'), JSON.stringify(g)); // an un-ignored node_modules would legitimately be listed
  }
  assert.equal(files(d, 1).length, 1, 'limit respected');
  const h = await startHatch({ cwd: d }); try { const r = (await h.call('GET', '/api/files')).data; assert.equal(r.dir, d); assert.ok(r.files.includes('b.md')); } finally { await h.close(); }
});
