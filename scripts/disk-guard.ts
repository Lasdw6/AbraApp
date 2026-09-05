import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { availableBytes, GiB, requireDiskSpace } from '../abra-teleport/src/disk-space.js';

export async function guardCommand(command: string, args: string[], options: {
  directories?: string[]; minimum?: number; reserve?: number; interval?: number;
  read?: typeof availableBytes;
} = {}) {
  const read = options.read || availableBytes;
  const directories = options.directories || [process.cwd(), os.tmpdir(),
    process.env.CARGO_TARGET_DIR || path.resolve('abra/target'), process.env.CARGO_HOME || path.join(os.homedir(), '.cargo')];
  for (const directory of directories) await requireDiskSpace(directory, options.minimum ?? 8 * GiB, read);
  if (command === 'npm') {
    if (!process.env.npm_execpath) throw new Error('Run this build through npm.');
    args = [process.env.npm_execpath, ...args]; command = process.execPath;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32' });
    let failure: Error | undefined;
    let checking = false;
    let finished = false;
    const stop = (error: unknown) => {
      if (finished || failure) return;
      failure = error instanceof Error ? error : new Error(String(error));
      if (!child.pid) return;
      // Stop this build's entire process tree so compilers cannot keep filling disk.
      if (process.platform === 'win32') {
        const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        if (result.status !== 0) child.kill();
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setInterval(async () => {
      if (checking || finished || failure) return;
      checking = true;
      try { for (const directory of directories) await requireDiskSpace(directory, options.reserve ?? 2 * GiB, read); }
      catch (error) { stop(error); }
      finally { checking = false; }
    }, options.interval ?? 500);
    child.once('error', error => { finished = true; clearInterval(timer); reject(error); });
    child.once('close', code => {
      finished = true; clearInterval(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Build exited with status ${code}.`));
      else resolve();
    });
  });
}
