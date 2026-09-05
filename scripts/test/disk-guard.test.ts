import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { guardCommand } from '../disk-guard.js';

test('low-space preflight refuses a build before it writes anything', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-disk-guard-'));
  const marker = path.join(root, 'started');
  try {
    await assert.rejects(guardCommand(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
      { directories: [root], minimum: 100, read: async () => 99 }), /Not enough free disk space/);
    await assert.rejects(access(marker));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('space monitoring terminates the build process tree before the reserve is exhausted', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-disk-watch-'));
  const marker = path.join(root, 'heartbeat');
  const grandchild = `setInterval(() => require('fs').writeFileSync(${JSON.stringify(marker)}, String(Date.now())), 20)`;
  const child = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:'inherit'}); setInterval(() => {}, 1000)`;
  try {
    await assert.rejects(guardCommand(process.execPath, ['-e', child], {
      directories: [root], minimum: 100, reserve: 50, interval: 20,
      read: async () => await access(marker).then(() => 49, () => 200),
    }), /Not enough free disk space/);
    const stopped = await readFile(marker, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await readFile(marker, 'utf8'), stopped, 'the compiler descendant must also stop writing');
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
