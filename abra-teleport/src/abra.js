import { closeSync, openSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appRoot, browserAdapterCandidates, paths } from './paths.js';
import { executableOnPath, exists, isProcessAlive, processIdentity, readJson, runJson, secureDir, sleep, writeJson } from './util.js';

let resolvedBinary;

export async function abraBinary() {
  if (resolvedBinary) return resolvedBinary;
  const candidates = [
    process.env.ABRA_BIN,
    path.join(appRoot, 'runtime', `${process.platform}-${process.arch}`, 'abra'),
    path.resolve(appRoot, '..', 'abra', 'target', 'release', 'abra'),
    path.resolve(appRoot, '..', 'abra', 'target', 'debug', 'abra'),
    await executableOnPath('abra')
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await exists(candidate)) return (resolvedBinary = candidate);
  }
  throw new Error('Abra was not found. Set ABRA_BIN or build ../abra/target/release/abra');
}

function daemonEnv() {
  return { ABRA_BROWSER_DATA_DIR: paths().browserData };
}

export async function abra(args, options = {}) {
  const binary = await abraBinary();
  return runJson(binary, ['--root', paths().abraRoot, '--json', ...args], { ...options, env: { ...daemonEnv(), ...options.env } });
}

export async function daemonStatus() {
  try { return await abra(['status'], { timeout: 3000 }); }
  catch { return null; }
}

export async function browserAdapterDirectory() {
  for (const candidate of browserAdapterCandidates()) {
    if (await exists(path.join(candidate, 'abra-adapter.json'))) return candidate;
  }
  throw new Error('browser-session adapter was not found. Set ABRA_BROWSER_ADAPTER to the Abra adapter directory');
}

async function addAdapter(name, directory) {
  const listed = await abra(['adapters', 'list']);
  const current = listed.adapters?.find(item => item.manifest?.name === name);
  if (!current) await abra(['adapters', 'add', directory]);
}

export async function ensureAdapters() {
  await addAdapter('dev.abra.teleport-agent', path.join(appRoot, 'adapters', 'teleport-agent'));
  await addAdapter('dev.abra.codex-session', paths().codexAdapter);
  await addAdapter('dev.abra.browser-session', await browserAdapterDirectory());
  const listed = await abra(['adapters', 'list']);
  if (listed.errors?.length) throw new Error(`Abra adapter discovery failed: ${listed.errors.join('; ')}`);
  return listed;
}

export async function ensureDaemon() {
  await secureDir(paths().home);
  await secureDir(paths().abraRoot);
  await secureDir(paths().browserData);
  const running = await daemonStatus();
  if (running) {
    await ensureAdapters();
    return { ...running, started: false };
  }

  const binary = await abraBinary();
  const log = openSync(paths().daemonLog, 'a', 0o600);
  const transport = process.env.ABRA_TELEPORT_TRANSPORT;
  const args = ['--root', paths().abraRoot, 'daemon', '--yes'];
  if (transport) args.push('--transport', transport);
  const child = spawn(binary, args, {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, ...daemonEnv() }
  });
  child.unref();
  closeSync(log);
  const identity = await processIdentity(child.pid);
  await writeJson(paths().daemonState, { pid: child.pid, binary, root: paths().abraRoot, started_at: identity.started_at });
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await daemonStatus();
    if (status) {
      await ensureAdapters();
      return { ...status, started: true };
    }
    if (!await isProcessAlive(child.pid)) break;
    await sleep(50);
  }
  throw new Error(`Abra daemon did not start. See ${paths().daemonLog}`);
}

export async function stopDaemon() {
  const state = await readJson(paths().daemonState, null);
  if (!state || !await isProcessAlive(state.pid)) return { stopped: false };
  const identity = await processIdentity(state.pid);
  if (!state.started_at || identity.started_at !== state.started_at || !identity.command.includes(state.binary) || !identity.command.includes(paths().abraRoot) || !identity.command.includes('daemon')) {
    throw new Error(`refusing to stop PID ${state.pid}; it is not the recorded Abra daemon`);
  }
  process.kill(state.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 100 && await isProcessAlive(state.pid); attempt++) await sleep(50);
  return { stopped: !await isProcessAlive(state.pid) };
}

export async function waitForAck(snapshotId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const outbox = await abra(['outbox']);
    const entry = outbox.find(item => item.snapshot_id === snapshotId);
    if (entry?.state === 'acked') return entry;
    if (['failed', 'cancelled', 'expired'].includes(entry?.state)) {
      throw new Error(`Abra delivery ${snapshotId} ended as ${entry.state}: ${entry.last_error || 'no detail'}`);
    }
    await sleep(250);
  }
  throw new Error(`Abra delivery ${snapshotId} was not acknowledged within ${timeoutMs}ms`);
}

export async function ensurePrivateMaterialization(id) {
  const directory = path.join(paths().received, `${Date.now()}-${id}`);
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(directory), 0o700);
  return directory;
}
