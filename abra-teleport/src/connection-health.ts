import path from 'node:path';
import { agentRemote } from './agent.js';
import { paths } from './paths.js';
import { readJson, writeJson, redact } from './util.js';
import type { AgentDescriptor } from './types.js';

export interface ConnectionHealth {
  agent_id: string | null;
  status: 'connected' | 'unreachable' | 'unpaired';
  last_seen: string | null;
  checked_at: string;
  error: string | null;
}

export async function checkConnection(agent: AgentDescriptor | null, request = agentRemote): Promise<ConnectionHealth> {
  const checked_at = new Date().toISOString();
  if (!agent) return { agent_id: null, status: 'unpaired', last_seen: null, checked_at, error: null };
  if (!/^[0-9a-f]{64}$/.test(agent.peer_id) || agent.id !== agent.peer_id) throw new Error('Invalid agent identity.');
  const file = path.join(paths().home, 'connections', `${agent.peer_id}-health.json`);
  const previous = await readJson<ConnectionHealth | null>(file, null);
  let health: ConnectionHealth;
  try {
    // This read-only command also works with already installed Teleport CLIs.
    const remote = JSON.parse(await request(agent, ['doctor'], 8000));
    if (remote.daemon?.peer_id !== agent.peer_id) throw new Error('The connected agent returned an unexpected identity.');
    health = { agent_id: agent.id, status: 'connected', last_seen: new Date().toISOString(), checked_at, error: null };
  } catch (error) {
    health = { agent_id: agent.id, status: 'unreachable', last_seen: previous?.last_seen || null, checked_at,
      error: redact(error.message).slice(0, 400) };
  }
  await writeJson(file, health);
  return health;
}
