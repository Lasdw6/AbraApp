import { statfs } from 'node:fs/promises';
import path from 'node:path';

export const GiB = 1024 ** 3;
export async function availableBytes(directory: string): Promise<number> {
  let current = path.resolve(directory);
  for (;;) {
    try { const fs = await statfs(current); return fs.bavail * fs.bsize; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(current) === current) throw error;
      current = path.dirname(current);
    }
  }
}
export async function requireDiskSpace(directory: string, minimum = GiB, read = availableBytes) {
  const free = await read(directory);
  if (free < minimum) throw new Error(`Not enough free disk space for Abra at ${directory}: ${(free / GiB).toFixed(1)} GiB available; ${(minimum / GiB).toFixed(1)} GiB required. Free disk space before continuing to protect browser session data.`);
}
