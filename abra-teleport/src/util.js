import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { access, chmod, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function exists(file) {
  try { await access(file); return true; }
  catch { return false; }
}

export async function secureDir(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function readJson(file, fallback = undefined) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

export async function writeJson(file, value) {
  await secureDir(path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  await chmod(file, 0o600);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function redact(text) {
  return String(text)
    .replace(/abra-pair\/1\/[A-Za-z0-9_-]+/g, '[redacted-pair-ticket]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, '[redacted-openai-key]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted-github-token]')
    .replace(/\b(?:wss?|https?):\/\/[^\s"']+/g, '[redacted-url]');
}

export async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      input: options.input,
      maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
      timeout: options.timeout
    });
  } catch (error) {
    const detail = redact(String(error.stderr || error.stdout || error.message).trim());
    throw new Error(`${path.basename(command)} failed: ${detail}`, { cause: error });
  }
}

export async function runJson(command, args, options = {}) {
  const { stdout } = await run(command, args, options);
  try { return JSON.parse(stdout); }
  catch { throw new Error(`${path.basename(command)} returned invalid JSON: ${redact(stdout.trim()).slice(0, 500)}`); }
}

export function runInteractive(command, args, options = {}) {
  return new Promise((resolve, reject) => {
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
  try { return (await run('/usr/bin/env', ['which', name])).stdout.trim(); }
  catch { return null; }
}

export async function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export async function processCommand(pid) {
  if (!await isProcessAlive(pid)) return '';
  return (await run('/bin/ps', ['-p', String(pid), '-o', 'command='])).stdout.trim();
}

export async function processIdentity(pid) {
  if (!await isProcessAlive(pid)) return null;
  const stdout = (await run('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='])).stdout.trim();
  const match = stdout.match(/^(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+([\s\S]+)$/);
  if (!match) throw new Error(`could not read process identity for PID ${pid}`);
  return { started_at: match[1].replace(/\s+/g, ' '), command: match[2] };
}

export async function fileSize(file) {
  return (await stat(file)).size;
}

export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
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
