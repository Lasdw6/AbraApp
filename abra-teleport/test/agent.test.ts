import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { agentArguments } from '../build/src/agent.js';
import { abraBinary } from '../build/src/abra.js';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

test('agent rejects arbitrary commands and pins browser destinations', () => {
  const agent = { controller: 'a'.repeat(64) };
  for (const argv of [['exec', 'sh'], ['browser', 'exec', '--', 'sh', '/tmp/arbitrary.js'], ['codex', 'resume'], ['app', 'exec']]) {
    assert.throws(() => agentArguments(argv, agent));
  }
  const browser = agentArguments(['browser', 'receive', 'b'.repeat(64), '--from', 'attacker', '--headed'], agent);
  assert.deepEqual(browser.slice(-2), ['--from', agent.controller]);
  assert.deepEqual(agentArguments(['browser', 'receive', 'b'.repeat(64), '--allow-non-portable', '--from', 'attacker'], agent), ['browser', 'receive', 'b'.repeat(64), '--from', agent.controller, '--allow-non-portable']);
  assert.throws(() => agentArguments(['codex', 'run', 'task'], agent));
  assert.throws(() => agentArguments(['monitor', 'report'], agent));
  assert.deepEqual(agentArguments(['browser', 'down', 'attacker', '--session', 'B'.repeat(32)], agent), ['browser', 'down', agent.controller, '--all-domains', '--session', 'B'.repeat(32)]);
  assert.throws(() => agentArguments(['browser', 'revoke', '--session', '../bad'], agent));
  assert.throws(() => agentArguments(['browser', 'send-tab', '../bad'], agent));
});

test('app upgrades restart the managed daemon and preserve its identity', { skip: process.env.ABRA_TELEPORT_INTEGRATION !== '1', timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'abra-upgrade-test-'));
  const home = path.join(directory, 'home');
  const oldBinary = path.join(directory, 'old-abra'), newBinary = path.join(directory, 'new-abra');
  const stateFile = path.join(home, 'daemon.json');
  const state = async () => JSON.parse(await readFile(stateFile, 'utf8'));
  const command = async (binary, args) => {
    const { stdout } = await exec(process.execPath, [path.join(root, 'build/bin/abra-teleport.js'), ...args], {
      env: { ...process.env, ABRA_BIN: binary, ABRA_TELEPORT_HOME: home, ABRA_TELEPORT_ABRA_ROOT: path.join(home, 'abra'),
        ABRA_BROWSER_DATA_DIR: path.join(home, 'browser-adapter'), ABRA_TELEPORT_TRANSPORT: 'tcp' }, timeout: 65000
    });
    return JSON.parse(stdout);
  };
  try {
    await copyFile(await abraBinary(), oldBinary);
    await copyFile(oldBinary, newBinary);
    await command(oldBinary, ['setup']);
    const original = await state();
    const before = await command(oldBinary, ['doctor']);
    const legacy = { ...original };
    delete legacy.binary_stamp;
    await writeFile(stateFile, JSON.stringify(legacy));
    assert.ok((await command(newBinary, ['agent', 'ticket'])).command);
    const upgraded = await state();
    assert.notEqual(upgraded.pid, original.pid);
    assert.equal(upgraded.binary, newBinary);
    assert.ok(upgraded.binary_stamp);
    assert.equal((await command(newBinary, ['doctor'])).daemon.peer_id, before.daemon.peer_id);
    await command(newBinary, ['agent', 'ticket']);
    assert.equal((await state()).pid, upgraded.pid, 'unchanged builds keep the daemon running');
    const modified = new Date(Date.now() + 2000);
    await utimes(newBinary, modified, modified);
    await command(newBinary, ['agent', 'ticket']);
    assert.notEqual((await state()).pid, upgraded.pid, 'replacement at the same path restarts the daemon');
    assert.equal((await command(newBinary, ['doctor'])).daemon.peer_id, before.daemon.peer_id);
  } finally {
    await command(newBinary, ['daemon', 'stop']).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('pairing command connects two isolated agents and controls the remote CLI', { skip: process.env.ABRA_TELEPORT_INTEGRATION !== '1', timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'abra-agent-test-'));
  const a = path.join(directory, 'a'), b = path.join(directory, 'b');
  const env = home => ({ ...process.env, ABRA_TELEPORT_HOME: home, ABRA_TELEPORT_ABRA_ROOT: path.join(home, 'abra'),
    ABRA_BROWSER_DATA_DIR: path.join(home, 'browser-adapter'), ABRA_TELEPORT_TRANSPORT: 'tcp' });
  const command = async (home, args) => {
    const { stdout } = await exec(process.execPath, [path.join(root, 'build/bin/abra-teleport.js'), ...args], { env: env(home), timeout: 65000 });
    return JSON.parse(stdout);
  };
  try {
    await mkdir(path.join(a, 'abra/adapters'), { recursive: true });
    await writeFile(path.join(a, 'abra/adapters/registry.json'), JSON.stringify(['/removed/old-wrapper/adapters/codex-session']));
    const ticket = await command(a, ['agent', 'ticket']);
    const token = ticket.command.match(/'([^']+)'/)[1];
    const connected = await command(b, ['agent', 'connect', token, 'test sandbox']);
    assert.equal(connected.connected, true);
    const agents = await command(a, ['agent', 'list']);
    assert.equal(agents.length, 1); assert.equal(agents[0].name, 'test sandbox');
    const { spawn } = await import('node:child_process');
    const remote = await new Promise<{ app_home: string; daemon: { peer_id: string } }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'build/bin/abra-teleport.js'), 'agent', 'remote'], { env: env(a), stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', error = '';
      child.stdout.on('data', data => output += data); child.stderr.on('data', data => error += data);
      child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
      child.stdin.end(JSON.stringify({ config: agents[0], argv: ['doctor'] }));
    });
    assert.equal(remote.app_home, b);
    assert.equal(remote.daemon.peer_id, connected.peer_id);
    const health = () => new Promise<{ status: string; last_seen: string | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'build/bin/abra-teleport.js'), 'agent', 'health'], { env: env(a), stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', error = '';
      child.stdout.on('data', data => output += data); child.stderr.on('data', data => error += data);
      child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
      child.stdin.end(JSON.stringify({ config: agents[0] }));
    });
    const live = await health();
    assert.equal(live.status, 'connected'); assert.ok(live.last_seen);
    await command(b, ['daemon', 'stop']);
    const lost = await health();
    assert.equal(lost.status, 'unreachable'); assert.equal(lost.last_seen, live.last_seen);
    await command(b, ['setup']);
    assert.equal((await health()).status, 'connected');
    const nextTicket = await command(a, ['agent', 'ticket']);
    const reconnected = await command(b, ['agent', 'connect', nextTicket.command.match(/'([^']+)'/)[1], 'test sandbox']);
    assert.equal(reconnected.peer_id, connected.peer_id);
    assert.equal(reconnected.capsule_id, connected.capsule_id);
  } finally {
    for (const home of [a, b]) await command(home, ['daemon', 'stop']).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
