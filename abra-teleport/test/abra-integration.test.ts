import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { abra, ensureDaemon, stopDaemon } from '../build/src/abra.js';
import { connectAgent, listAgents, agentRemote } from '../build/src/agent.js';
import { codexReceive, codexSend } from '../build/src/codex.js';
import { run } from '../build/src/util.js';

const enabled = process.env.ABRA_TELEPORT_INTEGRATION === '1';
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174111';

async function selectDevice(device) {
  process.env.ABRA_TELEPORT_HOME = device.home;
  process.env.CODEX_HOME = device.codex;
}

async function makeSession(home, version) {
  const directory = path.join(home, 'sessions', '2026', '09', '02');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-09-02T10-00-00-${SESSION_ID}.jsonl`);
  const records = [
    { timestamp: '2026-09-02T10:00:00Z', type: 'session_meta', payload: { id: SESSION_ID, session_id: SESSION_ID, cwd: '/source/project', cli_version: version, model_provider: 'openai', history_mode: 'full' } },
    { timestamp: '2026-09-02T10:01:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'integration test' } }
  ];
  await writeFile(file, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  return file;
}

test('two Abra daemons round-trip a Codex session and workspace', { skip: !enabled, timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-teleport-e2e-'));
  const deviceA = { home: path.join(root, 'a'), codex: path.join(root, 'a-codex'), workspace: path.join(root, 'a-workspace') };
  const deviceB = { home: path.join(root, 'b'), codex: path.join(root, 'b-codex'), workspace: path.join(root, 'b', 'workspace') };
  const original = { ...process.env };
  process.env.ABRA_BIN ||= path.resolve(import.meta.dirname, '..', '..', 'abra', 'target', 'debug', 'abra');
  process.env.ABRA_BROWSER_ADAPTER ||= path.resolve(import.meta.dirname, '..', '..', 'abra', 'adapters', 'browser-session');
  process.env.CODEX_BIN ||= (await run('/usr/bin/env', ['which', 'codex'])).stdout.trim();
  const version = (await run(process.env.CODEX_BIN, ['--version'])).stdout.trim().split(/\s+/).at(-1);
  await mkdir(deviceA.workspace, { recursive: true });
  await writeFile(path.join(deviceA.workspace, 'marker.txt'), 'before\n');
  const localSession = await makeSession(deviceA.codex, version);
  try {
    await selectDevice(deviceA);
    const statusA = await ensureDaemon();
    const ticket = (await abra(['pair', 'ticket'])).ticket;
    await selectDevice(deviceB);
    const statusB = await connectAgent(ticket, 'codex sandbox');
    await selectDevice(deviceA);
    const [agent] = await listAgents();

    const sent = await codexSend(statusB.peer_id, { session: SESSION_ID, workspace: deviceA.workspace, timeout: 30000, 'confirm-workspace': true });
    await writeFile(path.join(deviceA.workspace, 'marker.txt'), 'local-dirty\n');
    await agentRemote(agent, ['codex', 'receive', sent.session_snapshot_id]);
    assert.equal(await readFile(path.join(deviceB.workspace, 'marker.txt'), 'utf8'), 'before\n');
    const cloudSession = path.join(deviceB.codex, 'sessions', '2026', '09', '02', `rollout-2026-09-02T10-00-00-${SESSION_ID}.jsonl`);
    await appendFile(cloudSession, `${JSON.stringify({ timestamp: '2026-09-02T10:02:00Z', type: 'event_msg', payload: { type: 'agent_message', message: 'cloud turn' } })}\n`);
    await writeFile(path.join(deviceB.workspace, 'marker.txt'), 'after\n');
    await agentRemote(agent, ['codex', 'down']);

    await selectDevice(deviceA);
    await assert.rejects(codexReceive(undefined, { workspace: deviceA.workspace }), /local workspace changed while the Codex session was away/);
    assert.equal(await readFile(path.join(deviceA.workspace, 'marker.txt'), 'utf8'), 'local-dirty\n');
    assert.doesNotMatch(await readFile(localSession, 'utf8'), /cloud turn/);
    await writeFile(path.join(deviceA.workspace, 'marker.txt'), 'before\n');
    await codexReceive(undefined, { workspace: deviceA.workspace });
    assert.equal(await readFile(path.join(deviceA.workspace, 'marker.txt'), 'utf8'), 'after\n');
    assert.match(await readFile(localSession, 'utf8'), /cloud turn/);
  } finally {
    await selectDevice(deviceA); await stopDaemon().catch(() => {});
    await selectDevice(deviceB); await stopDaemon().catch(() => {});
    Object.keys(process.env).forEach(key => { if (!(key in original)) delete process.env[key]; });
    Object.assign(process.env, original);
    await rm(root, { recursive: true, force: true });
  }
});
