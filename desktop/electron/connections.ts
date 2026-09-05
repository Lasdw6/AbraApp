import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

import type { RuntimePaths, AgentDescriptor as Agent } from '../shared/contracts.js';

function createConnections({ home, runtime }: { home: string; runtime: () => RuntimePaths }) {
  const stateHome = process.env.ABRA_TELEPORT_HOME || path.join(home, '.abra-teleport');
  const file = path.join(stateHome, 'selected-agent.json');
  let pending = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let ready: Promise<void> | undefined;
  async function config(): Promise<Agent | null> {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function run<T = any>(args: string[], request?: unknown, timeout = 540000): Promise<T> {
    const rt = runtime();
    return new Promise<T>((resolve, reject) => {
      const child = spawn(rt.node, [path.join(rt.wrapper, 'bin/abra-teleport.js'), ...args], {
        timeout,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(rt.asNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ABRA_BIN: rt.abra,
          ABRA_BROWSER_ADAPTER: rt.adapter, ABRA_OBSERVER: rt.observer, ABRA_TELEPORT_DESKTOP: '1',
          PATH: [path.dirname(rt.node), process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean).join(path.delimiter) },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 32 * 1024 * 1024) child.kill(); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
      child.once('error', reject);
      child.once('close', code => {
        if (code !== 0) return reject(new Error(stderr.trim() || `Agent command exited ${code}.`));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Teleport returned an unreadable response.')); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(request ? JSON.stringify(request) : '');
    });
  }
  async function invoke<T = any>(args: string[], request?: unknown, timeout = 540000): Promise<T> {
    // Health, agent discovery, and handoff restoration can start together.
    // Finish any daemon upgrade once before letting those requests proceed.
    ready ??= run(['setup'], undefined, 20000).then(() => {}, error => { ready = undefined; throw error; });
    await ready;
    return run<T>(args, request, timeout);
  }
  async function select(id: string) {
    if (pending) throw new Error('Wait for the current handoff to finish.');
    const active = await readFile(path.join(stateHome, 'handoff.json'), 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return {}; throw error;
    });
    if (active.browser && active.agent && active.agent !== id) throw new Error('Bring back the active handoff before switching agents.');
    const agents = await invoke<Agent[]>(['agent', 'list']);
    const selected = agents.find(agent => agent.id === id);
    if (!selected) throw new Error('That agent has not connected.');
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file + '.tmp', JSON.stringify(selected), { mode: 0o600 });
    await rename(file + '.tmp', file);
    return selected;
  }
  function command(action: string, payload: Record<string, unknown> = {}) {
    pending += 1;
    const operation = queue.then(async () => {
      try {
        const selected = await config();
        if (!selected) throw new Error('Connect and select your agent first.');
        return await invoke(['sandbox', action], { config: selected, payload });
      } finally { pending -= 1; }
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return { config, select, command, health: async () => invoke(['agent', 'health'], { config: await config() }, 20000), ticket: () => invoke(['agent', 'ticket']), list: () => invoke(['agent', 'list']) };
}
export { createConnections };
