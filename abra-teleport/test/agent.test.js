import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { agentArguments } from '../src/agent.js';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

test('agent rejects arbitrary commands and pins browser/Codex destinations', () => {
  const agent = { controller: 'a'.repeat(64) };
  for (const argv of [['exec', 'sh'], ['browser', 'exec', '--', 'sh', '/tmp/arbitrary.js'], ['codex', 'resume'], ['app', 'exec']]) {
    assert.throws(() => agentArguments(argv, agent));
  }
  const browser = agentArguments(['browser', 'receive', 'b'.repeat(64), '--from', 'attacker', '--headed'], agent);
  assert.deepEqual(browser.slice(-3), ['--from', agent.controller, '--headless']);
  const codex = agentArguments(['codex', 'receive', 'b'.repeat(64), '--workspace', '/etc'], agent);
  assert.notEqual(codex.at(-1), '/etc');
  assert.deepEqual(agentArguments(['codex', 'run', 'do the task', '--return-to', 'attacker'], agent), ['codex', 'run', 'do the task', '--no-return']);
});

test('pairing command connects two isolated agents and controls the remote CLI', { skip: process.env.ABRA_TELEPORT_INTEGRATION !== '1', timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'abra-agent-test-'));
  const a = path.join(directory, 'a'), b = path.join(directory, 'b');
  const env = home => ({ ...process.env, ABRA_TELEPORT_HOME: home, ABRA_TELEPORT_ABRA_ROOT: path.join(home, 'abra'),
    ABRA_BROWSER_DATA_DIR: path.join(home, 'browser-adapter'), ABRA_TELEPORT_TRANSPORT: 'tcp' });
  const command = async (home, args) => {
    const { stdout } = await exec(process.execPath, [path.join(root, 'bin/abra-teleport.js'), ...args], { env: env(home), timeout: 65000 });
    return JSON.parse(stdout);
  };
  try {
    const ticket = await command(a, ['agent', 'ticket']);
    const token = ticket.command.match(/'([^']+)'/)[1];
    const connected = await command(b, ['agent', 'connect', token, 'test sandbox']);
    assert.equal(connected.connected, true);
    const agents = await command(a, ['agent', 'list']);
    assert.equal(agents.length, 1); assert.equal(agents[0].name, 'test sandbox');
    const { spawn } = await import('node:child_process');
    const remote = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'bin/abra-teleport.js'), 'agent', 'remote'], { env: env(a), stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', error = '';
      child.stdout.on('data', data => output += data); child.stderr.on('data', data => error += data);
      child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
      child.stdin.end(JSON.stringify({ config: agents[0], argv: ['doctor'] }));
    });
    assert.equal(remote.app_home, b);
    assert.equal(remote.daemon.peer_id, connected.peer_id);
    const nextTicket = await command(a, ['agent', 'ticket']);
    const reconnected = await command(b, ['agent', 'connect', nextTicket.command.match(/'([^']+)'/)[1], 'test sandbox']);
    assert.equal(reconnected.peer_id, connected.peer_id);
    assert.equal(reconnected.capsule_id, connected.capsule_id);
  } finally {
    for (const home of [a, b]) await command(home, ['daemon', 'stop']).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
