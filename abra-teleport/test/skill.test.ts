import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'build/bin/abra-teleport.js');

test('bundled skill can be read and installed without a core runtime; custom instructions are preserved', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'abra skill '));
  const env = { ...process.env, ABRA_BIN: path.join(directory, 'no-core'), ABRA_TELEPORT_SKILLS_DIR: directory };
  const run = (...args: string[]) => exec(process.execPath, [cli, 'skill', ...args], { env });
  try {
    const content = await readFile(path.join(root, 'skills/abra/SKILL.md'), 'utf8');
    assert.equal((await run()).stdout, content);
    const installed = JSON.parse((await run('install')).stdout);
    assert.equal(installed.path, path.join(directory, 'abra/SKILL.md'));
    assert.equal(await readFile(installed.path, 'utf8'), content);
    assert.equal(JSON.parse((await run('install')).stdout).changed, false);
    await writeFile(installed.path, 'My own instructions');
    await assert.rejects(run('install'), /different skill already exists/);
    assert.equal(await readFile(installed.path, 'utf8'), 'My own instructions');
    await run('install', '--force');
    assert.equal(await readFile(installed.path, 'utf8'), content);
    const custom = path.join(directory, 'custom skills');
    await run('install', '--dir', custom);
    assert.equal(await readFile(path.join(custom, 'abra/SKILL.md'), 'utf8'), content);
    await assert.rejects(run('install', '--dir'), /needs a skills directory/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('agent installer includes the skill and can be run again', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'abra skill installer '));
  try {
    const source = path.join(directory, 'package');
    await cp(path.join(root, 'build'), source, { recursive: true });
    const binaryDir = path.join(source, 'runtime', `${process.platform}-${process.arch}`);
    await mkdir(binaryDir, { recursive: true });
    await writeFile(path.join(binaryDir, 'abra'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = { ...process.env, ABRA_TELEPORT_INSTALL: path.join(directory, 'installed'),
      ABRA_TELEPORT_BIN_DIR: path.join(directory, 'bin'), ABRA_TELEPORT_SKILLS_DIR: path.join(directory, 'skills') };
    for (let i = 0; i < 2; i++) await exec('bash', [path.join(source, 'scripts/install-agent.sh')], { env });
    const { stdout } = await exec(path.join(env.ABRA_TELEPORT_BIN_DIR, 'abra-teleport'), ['skill'], { env });
    assert.equal(await readFile(path.join(env.ABRA_TELEPORT_SKILLS_DIR, 'abra/SKILL.md'), 'utf8'), stdout);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
