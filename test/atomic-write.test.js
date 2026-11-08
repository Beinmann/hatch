import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWrite, loadConfig, saveConfig } from '../src/state.js';
import { tmp } from './helpers.js';

const mode = (file) => fs.statSync(file).mode & 0o777;

test('atomic writes preserve modes and publish final permissions before replacing the destination', (t) => {
  const dir = tmp(); const file = path.join(dir, 'script');
  try {
    fs.writeFileSync(file, 'before', { mode: 0o751 });
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (source, target) => {
      assert.equal(mode(source), 0o751); assert.equal(fs.readFileSync(target, 'utf8'), 'before');
      assert.equal(fs.readFileSync(source, 'utf8'), 'after');
      return rename(source, target);
    });
    atomicWrite(file, 'after');
    assert.equal(mode(file), 0o751); assert.equal(fs.readFileSync(file, 'utf8'), 'after');
    assert.deepEqual(fs.readdirSync(dir), ['script']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('atomic writes honor umask for new files and explicit permissions independently of umask', () => {
  const dir = tmp(); const file = path.join(dir, 'new'); const explicit = path.join(dir, 'explicit');
  try {
    const script = `import { atomicWrite } from ${JSON.stringify(new URL('../src/state.js', import.meta.url).href)};
      process.umask(0o077); atomicWrite(process.argv[1], 'new'); atomicWrite(process.argv[2], 'explicit', { mode: 0o751 });`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, file, explicit], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(mode(file), 0o600); assert.equal(mode(explicit), 0o751);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a partial atomic-write failure keeps the original, closes its descriptor and removes temporary data', (t) => {
  const dir = tmp(); const file = path.join(dir, 'original');
  try {
    fs.writeFileSync(file, 'safe'); let descriptor;
    const write = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (fd, data, ...args) => {
      if (typeof fd !== 'number') return write(fd, data, ...args);
      descriptor = fd; assert.equal(fs.fstatSync(fd).mode & 0o777, 0o600);
      write(fd, 'partial data'); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    assert.throws(() => atomicWrite(file, 'replacement'), e => e.code === 'ENOSPC');
    assert.equal(fs.readFileSync(file, 'utf8'), 'safe'); assert.deepEqual(fs.readdirSync(dir), ['original']);
    assert.throws(() => fs.fstatSync(descriptor), e => e.code === 'EBADF');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed atomic rename removes its temporary file and preserves the existing destination', () => {
  const dir = tmp(); const target = path.join(dir, 'directory');
  try {
    fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep'), 'original');
    assert.throws(() => atomicWrite(target, 'cannot replace directory'));
    assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(dir), ['directory']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('exclusive atomic temporary files never overwrite or remove pre-existing links', (t) => {
  const dir = tmp(); const file = path.join(dir, 'destination'); const victim = path.join(dir, 'other');
  const suffix = Buffer.alloc(6, 1); const collision = `${file}.${process.pid}.${suffix.toString('hex')}.tmp`;
  try {
    fs.writeFileSync(file, 'destination'); fs.writeFileSync(victim, 'keep'); fs.symlinkSync(victim, collision);
    t.mock.method(crypto, 'randomBytes', () => suffix);
    assert.throws(() => atomicWrite(file, 'bad'), e => e.code === 'EEXIST');
    assert.equal(fs.readFileSync(file, 'utf8'), 'destination'); assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
    assert.ok(fs.lstatSync(collision).isSymbolicLink());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('configuration writes publish private files even when the previous mode was public', () => {
  const dir = tmp(); const config = path.join(dir, 'config.json');
  try {
    const value = loadConfig(dir); assert.equal(mode(config), 0o600);
    fs.chmodSync(config, 0o644); saveConfig(dir, value); assert.equal(mode(config), 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
