const { readFile, mkdir, writeFile, rename } = require('node:fs/promises');
const { spawn } = require('node:child_process');
const path = require('node:path');

function createConnections({ home, runtime }) {
  const file = path.join(home, '.abra-teleport/selected-agent.json');
  let pending = 0;
  let queue = Promise.resolve();
  async function config() {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function invoke(args, request) {
    const rt = runtime();
    return new Promise((resolve, reject) => {
      const child = spawn(rt.node, [path.join(rt.wrapper, 'bin/abra-teleport.js'), ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(rt.asNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ABRA_BIN: rt.abra,
          ABRA_BROWSER_ADAPTER: rt.adapter, ABRA_OBSERVER: rt.observer },
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
  async function select(id) {
    if (pending) throw new Error('Wait for the current handoff to finish.');
    const active = await readFile(path.join(home, '.abra-teleport/handoff.json'), 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return {}; throw error;
    });
    if (active.agent && active.agent !== id) throw new Error('Bring back the active handoff before switching agents.');
    const agents = await invoke(['agent', 'list']);
    const selected = agents.find(agent => agent.id === id);
    if (!selected) throw new Error('That agent has not connected.');
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file + '.tmp', JSON.stringify(selected), { mode: 0o600 });
    await rename(file + '.tmp', file);
    return selected;
  }
  function command(action, payload = {}) {
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
  return { config, select, command, ticket: () => invoke(['agent', 'ticket']), list: () => invoke(['agent', 'list']) };
}
module.exports = { createConnections };
