import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function regularChromeRoots() {
  if (process.platform === 'win32') return [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'Google/Chrome/User Data')];
  if (process.platform === 'darwin') return [path.join(os.homedir(), 'Library/Application Support/Google/Chrome')];
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return [path.join(config, 'google-chrome'), path.join(config, 'chromium')];
}
async function resolvedDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(absolute) === absolute) throw error;
    return path.join(await resolvedDirectory(path.dirname(absolute)), path.basename(absolute));
  }
}
function contains(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
export async function assertManagedProfile(profile: string, roots = regularChromeRoots()) {
  const candidate = await resolvedDirectory(profile);
  for (const root of roots) {
    const regular = await resolvedDirectory(root);
    if (contains(regular, candidate) || contains(candidate, regular)) {
      throw new Error('Abra must use its own Chrome profile. The configured capture profile overlaps your regular Chrome data; choose a separate ABRA_TELEPORT_HOME.');
    }
  }
}
