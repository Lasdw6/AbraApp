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
  assert.deepEqual(agentArguments(['inventory'], agent), ['inventory']);
  assert.throws(() => agentArguments(['inventory', 'browser'], agent));
  for (const id of ['a'.repeat(32), `managed:${'a'.repeat(32)}`, 'chrome:42']) {
    assert.deepEqual(agentArguments(['browser', 'send-tab', id], agent), ['browser', 'send-tab', id]);
  }
  for (const id of ['managed:../escape', 'chrome:$(whoami)', `managed:${'z'.repeat(32)}`, 'other:42']) {
    assert.throws(() => agentArguments(['browser', 'send-tab', id], agent));
  }
});

test('binary lookup follows a changed explicit runtime', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'abra-binary-test-'));
  const previous = process.env.ABRA_BIN;
  try {
    for (const name of ['first', 'second']) {
      const binary = path.join(directory, name);
      await writeFile(binary, 'fixture');
      process.env.ABRA_BIN = binary;
      assert.equal(await abraBinary(), binary);
    }
  } finally {
    if (previous === undefined) delete process.env.ABRA_BIN;
    else process.env.ABRA_BIN = previous;
    await rm(directory, { recursive: true, force: true });
  }
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
    const startups = await Promise.all([command(oldBinary, ['setup']), command(oldBinary, ['setup'])]);
    assert.equal(startups[0].peer_id, startups[1].peer_id, 'concurrent setup shares one daemon');
    const original = await state();
    const pidFile = path.join(home, 'abra', 'daemon.pid');
    assert.equal(JSON.parse(await readFile(pidFile, 'utf8')).pid, original.pid);
    // Simulate a pre-migration Teleport daemon with only its legacy record.
    await rm(pidFile);
    const before = await command(oldBinary, ['doctor']);
    const legacy = { ...original };
    delete legacy.binary_stamp;
    await writeFile(stateFile, JSON.stringify({ ...legacy, started_at: 'a different process' }));
    await assert.rejects(command(oldBinary, ['daemon', 'stop']), /not the recorded Abra daemon/);
    assert.equal((await command(oldBinary, ['doctor'])).daemon.peer_id, before.daemon.peer_id);
    await rm(pidFile);
    await writeFile(stateFile, JSON.stringify(legacy));
    assert.ok((await command(newBinary, ['agent', 'ticket', '--full'])).command);
    const upgraded = await state();
    assert.notEqual(upgraded.pid, original.pid);
    assert.equal(upgraded.binary, newBinary);
    assert.ok(upgraded.binary_stamp);
    assert.equal(JSON.parse(await readFile(pidFile, 'utf8')).pid, upgraded.pid);
    assert.equal((await command(newBinary, ['doctor'])).daemon.peer_id, before.daemon.peer_id);
    await command(newBinary, ['agent', 'ticket', '--full']);
    assert.equal((await state()).pid, upgraded.pid, 'unchanged builds keep the daemon running');
    const modified = new Date(Date.now() + 2000);
    await utimes(newBinary, modified, modified);
    await command(newBinary, ['agent', 'ticket', '--full']);
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
    const ticket = await command(a, ['agent', 'ticket', '--full']);
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
    const removed = await command(a, ['agent', 'remove', connected.peer_id]);
    assert.equal(removed.removed, true);
    assert.deepEqual(await command(a, ['agent', 'list']), []);
    assert.ok(!(await command(a, ['peers'])).some(peer => peer.peer_id === connected.peer_id));
    assert.equal((await health()).status, 'unreachable');
    const nextTicket = await command(a, ['agent', 'ticket', '--full']);
    const reconnected = await command(b, ['agent', 'connect', nextTicket.command.match(/'([^']+)'/)[1], 'test sandbox']);
    assert.equal(reconnected.peer_id, connected.peer_id);
    assert.equal(reconnected.capsule_id, connected.capsule_id);
    assert.equal((await command(a, ['agent', 'list'])).length, 1);
    assert.equal((await health()).status, 'connected');
  } finally {
    for (const home of [a, b]) await command(home, ['daemon', 'stop']).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
