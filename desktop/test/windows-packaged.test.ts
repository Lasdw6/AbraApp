import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Exercise Electron as the adapter interpreter, not the developer's node.exe.
test('packaged Windows runtime pairs and executes adapters from paths with spaces', {
  skip: process.platform !== 'win32' || process.env.ABRA_WINDOWS_PACKAGED_TEST !== '1', timeout: 120000,
}, () => {
  const unpacked = path.resolve(import.meta.dirname, '../dist/windows-native/win-unpacked');
  const app = path.join(unpacked, 'Abra Teleport.exe');
  const runtime = path.join(unpacked, 'resources/Runtime');
  const root = mkdtempSync(path.join(os.tmpdir(), 'abra packaged pair '));
  const run = (name: string, args: string[], input?: unknown): any => {
    const home = path.join(root, name);
    try {
      return JSON.parse(execFileSync(app, [path.join(runtime, 'wrapper/bin/abra-teleport.js'), ...args], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ABRA_TELEPORT_TRANSPORT: 'tcp',
          ABRA_TELEPORT_HOME: home, ABRA_TELEPORT_ABRA_ROOT: path.join(home, 'abra'),
          ABRA_BROWSER_DATA_DIR: path.join(home, 'browser-adapter'),
          ABRA_BIN: path.join(runtime, 'abra.exe'), ABRA_BROWSER_ADAPTER: path.join(runtime, 'browser-session') },
        encoding: 'utf8', windowsHide: true, timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'], input: input ? JSON.stringify(input) : undefined,
      }));
    } catch (error) {
      // execFileSync's message contains arguments, including pairing tickets.
      throw new Error(`Packaged ${args.slice(0, 2).join(' ')} failed: ${String((error as { stderr?: unknown }).stderr || 'no response')}`);
    }
  };
  try {
    const ticket = run('a', ['pair', 'ticket']).ticket;
    const connected = run('b', ['agent', 'connect', ticket, 'packaged test']);
    assert.equal(connected.connected, true);
    const agents = run('a', ['agent', 'list']);
    assert.equal(agents.length, 1);
    const remote = run('a', ['agent', 'remote'], { config: agents[0], argv: ['doctor'] });
    assert.equal(remote.daemon.peer_id, connected.peer_id);
    assert.equal(remote.app_home, path.join(root, 'b'));
  } finally {
    for (const home of ['a', 'b']) {
      try { run(home, ['daemon', 'stop']); } catch { /* Preserve the original failure. */ }
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
