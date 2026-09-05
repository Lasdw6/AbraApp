import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { windowsChromeCandidates } from '../build/src/chrome.js';
import { executableOnPath, processIdentity, processCommand } from '../build/src/util.js';

test('Windows Chrome lookup covers machine and per-user installations', () => {
  const env = { PROGRAMFILES: 'C:/Program Files', 'PROGRAMFILES(X86)': 'C:/Program Files (x86)', LOCALAPPDATA: 'C:/Users/Test User/AppData/Local' };
  assert.deepEqual(windowsChromeCandidates('win32', env), Object.values(env).map(root => path.join(root, 'Google/Chrome/Application/chrome.exe')));
  assert.deepEqual(windowsChromeCandidates('linux', env), []);
  assert.deepEqual(windowsChromeCandidates('win32', {}), []);
});

test('Windows process lookup returns a stable creation time and command', { skip: process.platform !== 'win32' }, async () => {
  const identity = await processIdentity(process.pid);
  assert.ok(identity?.started_at);
  assert.ok(identity.command.includes('node'));
  assert.deepEqual(await processIdentity(process.pid), identity);
  assert.equal(await processCommand(process.pid), identity.command);
  assert.equal(await processIdentity(-1), null);
  assert.match(await executableOnPath('node.exe') || '', /node\.exe$/i);
  assert.equal(await executableOnPath('abra-not-an-installed-command-1234'), null);
});
