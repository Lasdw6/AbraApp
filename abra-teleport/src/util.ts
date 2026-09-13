import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import { access, chmod, mkdir, open, readFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { paths } from './paths.js';
import type { RunOptions } from './types.js';

const execFileAsync = promisify(execFile);

export const sleep =  (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

export async function exists(file: string) {
  try { await access(file); return true; }
  catch { return false; }
}

// POSIX modes are ignored by Windows. Break inheritance on the state root once
// per process and grant only the current user, so a second account on the same
// computer cannot read pairing material or captured sessions.
const restricted = new Set<string>();
let warnedAboutAcls = false;

export function restrictWindowsDirectory(directory: string, run = spawnSync) {
  if (process.platform !== 'win32') return false;
  const key = path.resolve(directory).toLowerCase();
  if (restricted.has(key)) return false;
  restricted.add(key);
  const user = process.env.USERNAME;
  if (!user) return false;
  const result = run('icacls.exe', [path.resolve(directory), '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], { windowsHide: true, stdio: 'ignore' });
  if (!result.error && result.status === 0) return true;
  if (!warnedAboutAcls) {
    warnedAboutAcls = true;
    console.warn(`Could not restrict permissions on ${directory}; other accounts on this computer may be able to read Abra state.`);
  }
  return false;
}

export async function secureDir(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    if (path.resolve(directory).toLowerCase() === path.resolve(paths().home).toLowerCase()) restrictWindowsDirectory(directory);
    return;
  }
  await chmod(directory, 0o700);
}

// Windows keeps a brief lock on a file that antivirus, search indexing, or a
// just-closed handle still owns, so the rename in a temp-then-replace write can
// fail even though nothing is wrong. Retry before surfacing the error.
const RETRYABLE_REPLACE = new Set(['EPERM', 'EBUSY', 'EACCES']);

export async function replaceFile(temporary: string, target: string, attempts = 10, rename = renameSync) {
  for (let attempt = 0; ; attempt++) {
    try { return rename(temporary, target); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code || '';
      if (process.platform !== 'win32' || attempt >= attempts - 1 || !RETRYABLE_REPLACE.has(code)) throw error;
      await sleep(10 * (attempt + 1));
    }
  }
}

// Win32_Process.CommandLine quotes any argument containing a space, so a
// profile under "C:\Users\John Smith" never matches a raw substring test.
export function splitCommandLine(command: string) {
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const character of command) {
    if (character === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && /\s/.test(character)) {
      if (started) { args.push(current); current = ''; started = false; }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) args.push(current);
  return args;
}

export function stripQuotes(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

export function samePath(left: string, right: string) {
  const normalize = (value: string) => {
    const resolved = path.resolve(path.normalize(stripQuotes(value).replace(/^\\\\\?\\/, '')));
    return process.platform === 'win32' ? resolved.replace(/[\\/]+$/, '').toLowerCase() : resolved.replace(/\/+$/, '');
  };
  if (!left || !right) return false;
  return normalize(left) === normalize(right);
}

export function commandUsesProfile(command: string | undefined, profile: string) {
  if (!command) return false;
  // Unquoted POSIX command lines from `ps` cannot be split on spaces safely.
  if (command.includes(`--user-data-dir=${profile}`)) return true;
  return splitCommandLine(command).some(argument => {
    const value = stripQuotes(argument);
    return value.startsWith('--user-data-dir=') && samePath(value.slice('--user-data-dir='.length), profile);
  });
}

export function looksLikeElectron(binary: string | undefined) {
  if (Boolean(process.versions.electron) || process.env.ELECTRON_RUN_AS_NODE === '1') return true;
  if (!binary) return false;
  return /^(electron|abra[ -]teleport)(\.exe)?$/i.test(path.basename(binary));
}

export async function readJson<T = any>(file: string, fallback: unknown = undefined): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback as T;
    throw error;
  }
}

export async function writeJson(file: string, value: unknown) {
  await secureDir(path.dirname(file));
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.chmod(0o600);
      await handle.sync();
    } finally { await handle.close(); }
    await replaceFile(temporary, file);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function redact(text) {
  return String(text)
    .replace(/ABRA-(?:[A-Za-z0-9_-]{22}|[A-Z2-7]{8})/g, '[redacted-pair-code]')
    .replace(/abra-pair\/1\/[A-Za-z0-9_-]+/g, '[redacted-pair-ticket]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, '[redacted-openai-key]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted-github-token]')
    .replace(/\b(?:wss?|https?):\/\/[^\s"']+/g, '[redacted-url]');
}

export async function run(command: string, args: string[], options: RunOptions = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
      windowsHide: true,
      timeout: options.timeout
    });
  } catch (error) {
    const detail = redact(String(error.stderr || error.stdout || error.message).trim());
    throw new Error(`${path.basename(command)} failed: ${detail}`, { cause: error });
  }
}

export async function runJson<T = any>(command: string, args: string[], options: RunOptions = {}): Promise<T> {
  const { stdout } = await run(command, args, options);
  try { return JSON.parse(stdout); }
  catch { throw new Error(`${path.basename(command)} returned invalid JSON: ${redact(stdout.trim()).slice(0, 500)}`); }
}

export function runInteractive(command: string, args: string[], options: RunOptions = {}) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with ${signal || code}`));
    });
  });
}

export async function executableOnPath(name) {
  try { return (await run(process.platform === 'win32' ? 'where.exe' : '/usr/bin/env', process.platform === 'win32' ? [name] : ['which', name])).stdout.trim().split(/\r?\n/)[0]; }
  catch { return null; }
}

// A liveness probe costs a single system call on Windows as well as POSIX, so
// callers never need the far more expensive CIM identity query just to poll.
export function isAlive(pid: number | undefined) {
  if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) return false;
  try { process.kill(pid!, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    // Windows reports EPERM for a live process owned by another account.
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export async function isProcessAlive(pid: number | undefined) {
  return isAlive(pid);
}

export async function processCommand(pid: number) {
  if (!isAlive(pid)) return '';
  if (process.platform === 'win32') return (await windowsProcessIdentity(pid))?.command || '';
  return (await run('/bin/ps', ['-p', String(pid), '-o', 'command='])).stdout.trim();
}

export async function processIdentity(pid: number | undefined) {
  if (!isAlive(pid)) return null;
  if (process.platform === 'win32') return windowsProcessIdentity(pid!);
  const stdout = (await run('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='])).stdout.trim();
  const match = stdout.match(/^(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+([\s\S]+)$/);
  if (!match) throw new Error(`could not read process identity for PID ${pid}`);
  return { started_at: match[1].replace(/\s+/g, ' '), command: match[2] };
}

export async function fileSize(file: string) {
  return (await stat(file)).size;
}

export function parseArgs(argv: string[]) {
  const positionals: string[] = [];
  const flags: Record<string, any> = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    const parsed = next !== undefined && !next.startsWith('--') ? argv[++index] : true;
    if (flags[key] === undefined) flags[key] = parsed;
    else flags[key] = Array.isArray(flags[key]) ? [...flags[key], parsed] : [flags[key], parsed];
  }
  return { positionals, flags };
}

export function flagList(value) {
  if (value === undefined || value === true) return [];
  return (Array.isArray(value) ? value : [value]).flatMap(item => String(item).split(',')).map(item => item.trim()).filter(Boolean);
}

async function windowsProcessIdentity(pid: number): Promise<{ started_at: string; command: string } | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { @{started_at=$p.CreationDate.ToUniversalTime().ToString('o'); command=$p.CommandLine} | ConvertTo-Json -Compress }`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (!stdout.trim()) return null;
  const identity = JSON.parse(stdout);
  if (typeof identity.started_at !== 'string' || typeof identity.command !== 'string') throw new Error(`could not read process identity for PID ${pid}`);
  return identity;
}
