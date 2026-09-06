import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const installed = process.argv[2];
if (!installed) throw new Error('Pass the installed app directory.');
const app = path.join(installed, 'Abra Teleport.exe');
const core = path.join(installed, 'resources/Runtime/abra.exe');
const root = mkdtempSync(path.join(os.tmpdir(), 'abra installed smoke '));
const options = { encoding: 'utf8' as const, windowsHide: true, timeout: 15000 };
const run = (...args: string[]) => JSON.parse(execFileSync(core, ['--root', root, '--json', ...args], options));

try {
  const version = execFileSync(app, ['-e', 'console.log(process.versions.node)'], {
    ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(execFileSync(core, ['--version'], options), /^abra /);
  assert.ok(run('daemon', '--background', '--yes', '--transport', 'tcp').pid > 0);
  assert.equal(run('status').running, true);
  console.log('Installed runtime starts and responds.');
} finally {
  try {
    assert.equal(run('stop').stopped, true);
    console.log('Installed runtime stops cleanly.');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
