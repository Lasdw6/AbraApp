import { chmod, mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { appRoot, browserAdapterCandidates, paths } from './paths.js';
import { executableOnPath, exists, readJson, runJson, secureDir, writeJson } from './util.js';

import type { RunOptions } from './types.js';

let resolvedBinary: { override?: string; path: string } | undefined;

export async function abraBinary() {
  if (resolvedBinary && resolvedBinary.override === process.env.ABRA_BIN) return resolvedBinary.path;
  const name = process.platform === 'win32' ? 'abra.exe' : 'abra';
  const candidates = [
    process.env.ABRA_BIN,
    path.join(appRoot, 'runtime', `${process.platform}-${process.arch}`, name),
    path.resolve(appRoot, '..', 'abra', 'target', 'release', name),
    path.resolve(appRoot, '..', 'abra', 'target', 'debug', name),
    path.resolve(appRoot, '../..', 'abra/target/release', name),
    path.resolve(appRoot, '../..', 'abra/target/debug', name),
    await executableOnPath('abra')
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      resolvedBinary = { override: process.env.ABRA_BIN, path: candidate };
      return candidate;
    }
  }
  throw new Error('Abra was not found. Set ABRA_BIN or build ../abra/target/release/abra');
}

function daemonEnv() {
  return { ABRA_BROWSER_DATA_DIR: paths().browserData, ABRA_NODE_BIN: process.env.ABRA_NODE_BIN || process.execPath };
}

export async function abra<T = any>(args: string[], options: RunOptions = {}): Promise<T> {
  const binary = await abraBinary();
  return runJson<T>(binary, ['--root', paths().abraRoot, '--json', ...args], { ...options, env: { ...daemonEnv(), ...options.env } });
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

export async function ensureAdapters() {
  // Older app versions registered this adapter by path. Remove the stale entry
  // even when the upgraded app no longer contains its manifest.
  const registryFile = path.join(paths().abraRoot, 'adapters', 'registry.json');
  const registered = await readJson<string[]>(registryFile, []);
  const current = registered.filter(directory => path.basename(directory) !== 'codex-session');
  if (current.length !== registered.length) await writeJson(registryFile, current);
  let listed = await abra(['adapters', 'list']);
  let added = false;
  for (const [name, directory] of [
    ['dev.abra.teleport-agent', path.join(appRoot, 'adapters', 'teleport-agent')],
    ['dev.abra.browser-session', await browserAdapterDirectory()]
  ]) {
    if (!listed.adapters?.some(item => item.manifest?.name === name)) {
      try { await abra(['adapters', 'add', directory]); }
      catch (error) {
        const refreshed = await abra(['adapters', 'list']);
        if (!String(error.message).includes(`duplicate adapter name ${name}`) ||
            !refreshed.adapters?.some(item => item.manifest?.name === name && path.resolve(item.directory) === path.resolve(directory))) throw error;
      }
      added = true;
    }
  }
  if (added) listed = await abra(['adapters', 'list']);
  if (listed.errors?.length) throw new Error(`Abra adapter discovery failed: ${listed.errors.join('; ')}`);
  return listed;
}

export async function ensureDaemon() {
  await secureDir(paths().home);
  await secureDir(paths().abraRoot);
  await secureDir(paths().browserData);
  const binary = await abraBinary();
  const info = await stat(binary);
  const binaryStamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const running = await daemonStatus();
  if (running) {
    const state = await readJson(paths().daemonState, null);
    // Replacing the app does not replace its already-running daemon. Older
    // records have no stamp and need one restart before using new adapters.
    if (state && state.root === paths().abraRoot && (state.binary !== binary || state.binary_stamp !== binaryStamp)) {
      await stopDaemon();
      if (await daemonStatus()) throw new Error('Abra could not restart its outdated daemon.');
    } else {
      await ensureAdapters();
      return { ...running, started: false };
    }
  }

  const args = ['daemon', '--background', '--yes'];
  const transport = process.env.ABRA_TELEPORT_TRANSPORT;
  if (transport) args.push('--transport', transport);
  try {
    await abra(args, { timeout: 65000 });
  } catch (error) {
    // Another caller may have started the same daemon under Abra's launch lock.
    if (!String(error.message).includes('daemon already running') || !await daemonStatus()) throw error;
  }
  const record = await readJson(path.join(paths().abraRoot, 'daemon.pid'));
  await writeJson(paths().daemonState, { ...record, binary_stamp: binaryStamp });
  await ensureAdapters();
  return { ...await daemonStatus(), started: true };
}

export async function stopDaemon() {
  const pidFile = path.join(paths().abraRoot, 'daemon.pid');
  if (!await exists(pidFile)) {
    const legacy = await readJson(paths().daemonState, null);
    if (!legacy) return { stopped: false };
    if (legacy.root !== paths().abraRoot || !legacy.started_at || !legacy.binary || !Number.isSafeInteger(legacy.pid) || legacy.pid <= 0) {
      throw new Error('Cannot migrate the recorded Abra daemon: invalid process identity.');
    }
    // Old Teleport releases launched a foreground daemon. Hand its identity to
    // Abra, which verifies the live process before sending any signal.
    await secureDir(paths().abraRoot);
    try {
      const file = await open(pidFile, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(legacy)); } finally { await file.close(); }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return abra(['stop'], { timeout: 15000 });
}

export async function ensurePrivateMaterialization(id) {
  const directory = path.join(paths().received, `${Date.now()}-${id}`);
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(directory), 0o700);
  return directory;
}
