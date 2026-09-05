import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeJson } from '../build/src/util.js';
import { assertManagedProfile } from '../build/src/profile-safety.js';
import { requireDiskSpace, availableBytes } from '../build/src/disk-space.js';

test('failed state writes preserve existing data and remove partial temporary files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-write-safety-'));
  const file = path.join(root, 'state.json');
  const original = '{"session":"preserve-me"}';
  const probe = await open(path.join(root, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const write = prototype.writeFile;
  try {
    await writeFile(file, original);
    const mock = t.mock.method(prototype, 'writeFile', async function(this: unknown) {
      await write.call(this, 'partial');
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    await assert.rejects(writeJson(file, { session: 'new' }), /disk full/);
    mock.mock.restore();
    assert.equal(await readFile(file, 'utf8'), original);
    assert.deepEqual((await readdir(root)).sort(), ['probe', 'state.json']);
    await writeJson(file, { session: 'new' });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { session: 'new' });
  } finally { t.mock.restoreAll(); await rm(root, { recursive: true, force: true }); }
});

test('managed profiles reject regular Chrome roots and junctions into them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-profile-safety-'));
  const regular = path.join(root, 'regular');
  try {
    await mkdir(regular);
    await assert.rejects(assertManagedProfile(path.join(regular, 'Default'), [regular]), /regular Chrome/);
    await assert.rejects(assertManagedProfile(root, [regular]), /regular Chrome/);
    await assertManagedProfile(path.join(root, 'regular-other/chrome-profile'), [regular]);
    const link = path.join(root, 'managed-link');
    await symlink(regular, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(assertManagedProfile(path.join(link, 'chrome-profile'), [regular]), /regular Chrome/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('disk checks resolve nonexistent profile directories and reject low space', async () => {
  assert.ok(await availableBytes(path.join(os.tmpdir(), 'abra-nonexistent/profile')) > 0);
  await assert.rejects(requireDiskSpace(os.tmpdir(), 100, async () => 99), /Not enough free disk space/);
  await requireDiskSpace(os.tmpdir(), 100, async () => 100);
});

test('Windows adapter preserves cookie session files when a write fails', { skip: process.platform !== 'win32' }, async t => {
  const { writePrivate } = await import('../../abra/adapters/browser-session/lib/util.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-cookie-write-'));
  const file = path.join(root, 'state.json');
  const probe = await open(path.join(root, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const write = prototype.writeFile;
  try {
    await writeFile(file, 'original cookie state');
    const mock = t.mock.method(prototype, 'writeFile', async function(this: unknown) {
      await write.call(this, 'partial');
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    await assert.rejects(writePrivate(file, 'replacement cookie state'), /disk full/);
    mock.mock.restore();
    assert.equal(await readFile(file, 'utf8'), 'original cookie state');
    assert.deepEqual((await readdir(root)).sort(), ['probe', 'state.json']);
  } finally { t.mock.restoreAll(); await rm(root, { recursive: true, force: true }); }
});
