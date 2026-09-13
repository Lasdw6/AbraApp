import { spawnSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';

// Mirrors abra-teleport/src/util.ts. The Electron main process cannot import
// the CLI sources directly (they are built and packaged separately), so the two
// Windows behaviours the app depends on live here for its own state files.

const restricted = new Set<string>();
let warned = false;
const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

/** POSIX modes do nothing on Windows; break inheritance and grant only this user. */
export function restrictWindowsDirectory(directory: string, run = spawnSync) {
  if (process.platform !== 'win32') return false;
  const key = path.resolve(directory).toLowerCase();
  if (restricted.has(key)) return false;
  restricted.add(key);
  const user = process.env.USERNAME;
  if (!user) return false;
  const result = run('icacls.exe', [path.resolve(directory), '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], { windowsHide: true, stdio: 'ignore' });
  if (!result.error && result.status === 0) return true;
  if (!warned) {
    warned = true;
    console.warn(`Could not restrict permissions on ${directory}; other accounts on this computer may be able to read Abra state.`);
  }
  return false;
}

/** Creates a private state directory, applying Windows ACLs to the state root once. */
export async function secureDir(directory: string, root = directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') restrictWindowsDirectory(root);
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Completes a temp-then-rename write, retrying the brief Windows locks that antivirus and indexing cause. */
export async function replaceFile(temporary: string, target: string, attempts = 10, rename = renameSync) {
  for (let attempt = 0; ; attempt++) {
    try { return rename(temporary, target); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code || '';
      if (process.platform !== 'win32' || attempt >= attempts - 1 || !RETRYABLE.has(code)) throw error;
      await sleep(10 * (attempt + 1));
    }
  }
}
