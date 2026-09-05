const { spawn } = require('node:child_process');
const { createConnection, createServer } = require('node:net');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');

let running = null;
const allowedEnvironment = new Set(['NODE_ENV', 'PORT', 'HOST', 'RUST_LOG', 'PYTHONPATH', 'VIRTUAL_ENV']);

function appsRoot(home) { return path.join(home, 'Abra Apps'); }

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeName(value) {
  return String(value || 'app').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'app';
}

function target(home, name, sessionId) {
  const suffix = String(sessionId || '').replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'handoff';
  return path.join(appsRoot(home), `${safeName(name)}-${suffix}-${Date.now()}`);
}

async function readRecipes(workspace) {
  const file = path.join(workspace, '.abra', 'recipes.json');
  const recipes = JSON.parse(await readFile(file, 'utf8').catch(() => { throw new Error('The cloud workspace did not include a runnable server recipe.'); }));
  if (!Array.isArray(recipes)) throw new Error('The cloud server recipe is invalid.');
  return recipes.filter(recipe => recipe && Array.isArray(recipe.argv) && recipe.argv.length
    && recipe.argv.every(value => typeof value === 'string' && value.length <= 65536)
    && typeof recipe.cwd === 'string'
    && Array.isArray(recipe.ports) && recipe.ports.some(port => Number.isInteger(port) && port > 0 && port <= 65535));
}

async function commandExists(command) {
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    try { if ((await stat(path.join(directory, command))).isFile()) return true; } catch { /* next PATH entry */ }
  }
  return false;
}

function append(output, chunk) {
  output.push(String(chunk));
  if (output.length > 120) output.splice(0, output.length - 120);
}

function runToCompletion(command, args, cwd, env, output, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${command} timed out.`)); }, timeoutMs);
    child.stdout.on('data', chunk => append(output, chunk));
    child.stderr.on('data', chunk => append(output, chunk));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code}. ${output.slice(-5).join('').trim()}`));
    });
  });
}

async function installDependencies(cwd, command, output) {
  let pkg;
  try { pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')); }
  catch { return; }
  const dependencies = Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length;
  if (!dependencies) return;
  try { if ((await stat(path.join(cwd, 'node_modules'))).isDirectory()) return; } catch { /* install below */ }
  const manager = ['npm', 'pnpm', 'yarn', 'bun'].includes(command) ? command : 'npm';
  if (!await commandExists(manager)) throw new Error(`${manager} is required to start this app locally.`);
  const args = manager === 'npm'
    ? [await stat(path.join(cwd, 'package-lock.json')).then(() => 'ci').catch(() => 'install')]
    : ['install', '--frozen-lockfile'];
  await runToCompletion(manager, args, cwd, {}, output, 180000);
}

function portIsFree(port) {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function waitForPort(port, child, output, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (child.exitCode !== null) return reject(new Error(`The local server stopped before opening port ${port}. ${output.slice(-8).join('').trim()}`));
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`The local server did not open port ${port}. ${output.slice(-8).join('').trim()}`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

async function stop() {
  const previous = running;
  running = null;
  if (!previous?.child || previous.child.exitCode !== null) return { active: false };
  try { process.kill(-previous.child.pid, 'SIGTERM'); }
  catch { try { previous.child.kill('SIGTERM'); } catch { /* already stopped */ } }
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 3000);
    previous.child.once('close', () => { clearTimeout(timer); resolve(); });
  });
  return { active: false };
}

async function start(home, workspace) {
  const root = appsRoot(home);
  const resolved = path.resolve(workspace);
  if (!inside(root, resolved)) throw new Error(`Local app must be restored under ${root}.`);
  const info = await stat(resolved).catch(error => { throw new Error(`Restored app cannot be read: ${error.message}`); });
  if (!info.isDirectory()) throw new Error('Restored app is not a directory.');
  await stop();
  const recipe = (await readRecipes(resolved))[0];
  if (!recipe) throw new Error('No runnable server was found in the restored app.');
  const cwd = path.resolve(resolved, recipe.cwd);
  if (!inside(resolved, cwd)) throw new Error('The server recipe points outside the restored app.');
  const port = recipe.ports.find(value => Number.isInteger(value) && value > 0 && value <= 65535);
  if (!await portIsFree(port)) throw new Error(`Local port ${port} is already in use.`);
  const command = path.isAbsolute(recipe.argv[0]) ? path.basename(recipe.argv[0]) : recipe.argv[0];
  if (!await commandExists(command)) throw new Error(`${command} is required to start this app locally.`);
  const env = Object.fromEntries(Object.entries(recipe.env || {}).filter(([key, value]) => (allowedEnvironment.has(key) || key.startsWith('ABRA_RECIPE_')) && typeof value === 'string'));
  env.PORT = String(port);
  const output = [];
  await installDependencies(cwd, command, output);
  const child = spawn(command, recipe.argv.slice(1), { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => append(output, chunk));
  child.stderr.on('data', chunk => append(output, chunk));
  await waitForPort(port, child, output);
  const url = `http://127.0.0.1:${port}/`;
  running = { child, workspace: resolved, port, url, command: [command, ...recipe.argv.slice(1)], output };
  child.once('close', () => { if (running?.child === child) running = null; });
  return status();
}

function status() {
  if (!running || running.child.exitCode !== null) return { active: false, url: null };
  return { active: true, url: running.url, port: running.port, workspace: running.workspace, command: running.command, output: running.output.join('').slice(-12000) };
}

module.exports = { start, status, stop, target };
