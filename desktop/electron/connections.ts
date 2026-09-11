import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentDescriptor as Agent } from '../shared/contracts.js';
import type { TeleportService } from './teleport.js';
import type { IncomingHandoff } from './incoming.js';

function createConnections({ home, teleport }: { home: string; teleport: TeleportService }) {
  const stateHome = process.env.ABRA_TELEPORT_HOME || path.join(home, '.abra-teleport');
  const file = path.join(stateHome, 'selected-agent.json');
  const namesFile = path.join(stateHome, 'agent-names.json');
  let namesQueue: Promise<unknown> = Promise.resolve();
  async function names(): Promise<Record<string, string>> {
    try { return JSON.parse(await readFile(namesFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  const named = (agent: Agent, aliases: Record<string, string>): Agent => ({ ...agent, name: Object.hasOwn(aliases, agent.id) ? aliases[agent.id] : agent.name });
  let pending = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let ready: Promise<void> | undefined;
  async function config(): Promise<Agent | null> {
    try { return named(JSON.parse(await readFile(file, 'utf8')), await names()); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function invoke<T = any>(args: string[], request?: unknown, timeout = 540000): Promise<T> {
    // Health, agent discovery, and handoff restoration can start together.
    // Finish any daemon upgrade once before letting those requests proceed.
    const execute = teleport.run.bind(teleport);
    ready ??= execute(['setup'], undefined, 75000).then(() => {}, error => { ready = undefined; throw error; });
    await ready;
    return execute<T>(args, request, timeout);
  }
  async function list() {
    const agents = await invoke<Agent[]>(['agent', 'list']);
    const aliases = await names();
    return agents.map(agent => named(agent, aliases));
  }
  async function incoming(): Promise<IncomingHandoff[]> {
    const agents = new Map((await list()).map(agent => [agent.peer_id, agent]));
    const inbox = await invoke<Array<{ id: string; from: string; kind: string; read: boolean; received_at: string }>>(['inbox']);
    return inbox.filter(item => item.kind === 'dev.abra.browser.session.v1' && !item.read && agents.has(item.from))
      .map(item => ({ id: item.id, agent_id: agents.get(item.from)!.id, agent_name: agents.get(item.from)!.name, received_at: item.received_at }));
  }
  function renameAgent(id: string, name: string) {
    const operation = namesQueue.then(async () => {
      if (typeof id !== 'string' || !id || typeof name !== 'string' || !name.trim() || name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Use a name between 1 and 80 characters, without line breaks.');
      const selected = await config();
      const agent = selected?.id === id ? selected : (await list()).find(item => item.id === id);
      if (!agent) throw new Error('That agent has not connected.');
      const aliases = await names();
      aliases[id] = name.trim();
      await mkdir(stateHome, { recursive: true, mode: 0o700 });
      await writeFile(namesFile + '.tmp', JSON.stringify(aliases), { mode: 0o600 });
      await rename(namesFile + '.tmp', namesFile);
      return named(agent, aliases);
    });
    namesQueue = operation.catch(() => {});
    return operation;
  }
  async function selectAgent(id: string, persist = true) {
    const active = await readFile(path.join(stateHome, 'handoff.json'), 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return {}; throw error;
    });
    if ((active.browser || active.browsers?.length) && active.agent && active.agent !== id) throw new Error('Bring back the active handoff before switching agents.');
    const agents = await list();
    const selected = agents.find(agent => agent.id === id);
    if (!selected) throw new Error('That agent has not connected.');
    if (persist) await saveSelection(selected);
    return selected;
  }
  async function saveSelection(selected: Agent) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file + '.tmp', JSON.stringify(selected), { mode: 0o600 });
    await rename(file + '.tmp', file);
  }
  async function select(id: string) {
    if (pending) throw new Error('Wait for the current handoff to finish.');
    pending += 1;
    const operation = queue.then(() => selectAgent(id)).finally(() => { pending -= 1; });
    queue = operation.catch(() => {});
    return operation;
  }
  function command(action: string, payload: Record<string, unknown> = {}, agentId?: string) {
    pending += 1;
    const operation = queue.then(async () => {
      try {
        if (agentId !== undefined && (typeof agentId !== 'string' || !agentId || action !== 'browser-up')) throw new Error('Choose a valid agent for this tab.');
        const selected = agentId ? await selectAgent(agentId, false) : await config();
        if (!selected) throw new Error('Connect and select your agent first.');
        const result = await invoke(['sandbox', action], { config: selected, payload });
        if (agentId) await saveSelection(selected);
        return result;
      } finally { pending -= 1; }
    });
    queue = operation.catch(() => {});
    return operation;
  }
  function remove(id: string) {
    pending += 1;
    const operation = queue.then(async () => {
      try {
        if (!(await list()).some(agent => agent.id === id)) throw new Error('That agent has not connected.');
        await invoke(['agent', 'remove', id]);
        if ((await config())?.id === id) await rm(file, { force: true });
      } finally { pending -= 1; }
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return { config, select, rename: renameAgent, remove, command, incoming, health: async () => invoke(['agent', 'health'], { config: await config() }, 20000), ticket: () => invoke(['agent', 'ticket']), list };
}
export { createConnections };
