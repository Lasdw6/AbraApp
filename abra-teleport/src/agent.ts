import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { abra, ensureDaemon } from './abra.js';
import { paths } from './paths.js';
import { readJson, writeJson, run } from './util.js';
import { connectionCommand, installerUrl } from './install.js';

import type { AgentDescriptor } from './types.js';

export const AGENT_KIND = 'dev.abra.teleport.agent.v1';
export const agentFile = () => path.join(paths().home, 'agent.json');

export async function connectAgent(ticket, name = os.hostname()) {
  if (!ticket?.startsWith('abra-pair/1/')) throw new Error('Paste the pairing command from the Teleport app.');
  const previous = await readJson(agentFile(), null);
  if (previous) {
    let peer;
    try { peer = JSON.parse(Buffer.from(ticket.slice('abra-pair/1/'.length), 'base64url').toString()).peer_id; }
    catch { throw new Error('Invalid pairing command. Create a new one in the app.'); }
    // This preflight only pins the controller; Abra still verifies the signed ticket below.
    if (peer !== previous.controller) throw new Error('This agent is connected to another laptop. Use a separate ABRA_TELEPORT_HOME for another connection.');
  }
  const local = await ensureDaemon();
  const paired = await abra(['pair', 'add', ticket]);
  const control = path.join(paths().home, 'control');
  await mkdir(control, { recursive: true, mode: 0o700 });
  await writeJson(path.join(control, 'agent.json'), { name, version: 1 });
  let capsule;
  try { capsule = (await readFile(path.join(control, '.abra/capsule_id'), 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; capsule = (await abra(['init', control])).capsule_id; }
  const descriptor = { name, peer_id: local.peer_id, capsule_id: capsule, platform: process.platform, version: 1 };
  await writeJson(agentFile(), { ...descriptor, controller: paired.peer_id });
  const snapshot = await abra(['snapshot', control]);
  await abra(['send', paired.peer_id, '--snapshot', snapshot.snapshot_id, '--wait']);
  await abra(['send', paired.peer_id, '--kind', AGENT_KIND, '--source', JSON.stringify(descriptor), '--wait']);
  return { connected: true, ...descriptor };
}

export async function agentTicket() {
  await ensureDaemon();
  const { ticket } = await abra(['pair', 'ticket']);
  return { ...connectionCommand(ticket, await installerUrl()), expires_in_seconds: 600 };
}

export async function listAgents() {
  await ensureDaemon();
  const file = path.join(paths().home, 'agents.json');
  const agents = await readJson<Record<string, AgentDescriptor>>(file, {});
  const inbox = await abra(['inbox', '--kind', AGENT_KIND]);
  for (const item of inbox.filter(item => !item.read)) {
    const destination = path.join(paths().home, 'connections', item.id);
    await abra(['accept', item.id, destination, '--no-import']);
    const descriptor = await readJson(path.join(destination, 'agent.json'));
    if (descriptor.peer_id !== item.from || !/^[0-9a-f]{64}$/.test(descriptor.capsule_id || '')) throw new Error('Invalid agent announcement.');
    agents[item.from] = { id: item.from, ...descriptor };
  }
  await writeJson(file, agents);
  return Object.values(agents);
}

export async function agentRemote(config: AgentDescriptor, argv: string[], timeout = 540000) {
  await ensureDaemon();
  if (!config?.peer_id || !/^[0-9a-f]{64}$/.test(config.capsule_id || '')) throw new Error('Choose a connected agent.');
  const response = await abra(['control', config.peer_id, '--capsule', config.capsule_id, 'instruct', JSON.stringify({ argv })], { timeout });
  if (!response.ok) throw new Error(response.error || 'The agent refused the request.');
  if (typeof response.result?.stdout !== 'string') throw new Error('The agent returned no command output.');
  return response.result.stdout;
}

export function agentArguments(argv: unknown, agent: { controller: string }) {
  if (!Array.isArray(argv) || argv.some(x => typeof x !== 'string') || JSON.stringify(argv).length > 7500) throw new Error('Invalid agent request.');
  const [group, action] = argv;
  if (group === 'doctor' && argv.length === 1) return argv;
  if (group === 'browser' && action === 'available-tabs' && argv.length === 2) return argv;
  if (group === 'browser' && action === 'send-tab' && argv.length === 3 && /^[a-f0-9]{32}$/i.test(argv[2])) return argv;
  if (group === 'browser' && action === 'input' && argv.length === 3) return argv;
  if (group === 'browser' && action === 'exec') {
    const index = argv[2] === '--' ? 4 : 3;
    const script = path.basename(argv[index] || '');
    if (!['browser-cloud-screenshot.js'].includes(script)) throw new Error('Only Teleport browser actions are allowed.');
    return ['browser', 'exec', '--', process.execPath, path.resolve(import.meta.dirname, '../scripts', script), ...argv.slice(index + 1)];
  }
  if (group === 'browser' && action === 'receive') {
    if (!/^[0-9a-f]{64}$/.test(argv[2] || '')) throw new Error('Invalid browser handoff.');
    return ['browser', 'receive', argv[2], '--from', agent.controller];
  }
  if (group === 'browser' && ['down', 'revoke', 'close', 'status'].includes(action)) {
    const sessionIndex = argv.indexOf('--session');
    const session = sessionIndex >= 0 ? argv[sessionIndex + 1] : undefined;
    if (sessionIndex >= 0 && !/^[a-f0-9]{32}$/i.test(session || '')) throw new Error('Invalid browser session.');
    const selected = session ? ['--session', session] : [];
    return action === 'down' ? ['browser', 'down', agent.controller, '--all-domains', ...selected]
      : ['browser', action, ...(action === 'close' ? ['--force'] : selected)];
  }
  throw new Error('This command is not exposed by Teleport.');
}

export async function handleAgentControl(request) {
  const agent = await readJson(agentFile(), null);
  if (!agent || request.capsule_id !== agent.capsule_id) throw new Error('This control capsule is not enabled on this agent.');
  if (request.op !== 'instruct') throw new Error('Unsupported agent control.');
  const args = agentArguments(JSON.parse(request.text).argv, agent);
  const { stdout } = await run(process.execPath, [path.resolve(import.meta.dirname, '../bin/abra-teleport.js'), ...args], { timeout: 540000 });
  return { stdout };
}
