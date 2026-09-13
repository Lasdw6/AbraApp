import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function regularChromeRoots() {
  if (process.platform === 'win32') return [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'Google/Chrome/User Data')];
  if (process.platform === 'darwin') return [path.join(os.homedir(), 'Library/Application Support/Google/Chrome')];
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return [path.join(config, 'google-chrome'), path.join(config, 'chromium')];
}
// Windows realpath can answer with a verbatim `\\?\` prefix, a trailing
// separator, or a different letter case than the caller used. Compare the two
// sides in one canonical form so path.relative() cannot report a false mismatch.
export function normalizeResolved(directory: string, platform = process.platform) {
  let value = directory.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  value = (platform === 'win32' ? path.win32 : path.posix).normalize(value);
  if (platform !== 'win32') return value.length > 1 ? value.replace(/\/+$/, '') : value;
  // A drive root keeps its separator; anything else drops a trailing one.
  value = value.replace(/(?<=[^\\:])\\+$/, '');
  return value.toLowerCase();
}

async function resolvedDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  // The native resolver returns long 8.3-expanded names, which the JavaScript
  // one does not; fall back when it is unavailable or refuses the path.
  const resolve = async () => {
    if (process.platform !== 'win32') return realpath(absolute);
    try { return realpathSync.native(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error; return realpath(absolute); }
  };
  try { return normalizeResolved(await resolve()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(absolute) === absolute) throw error;
    return normalizeResolved(path.join(await resolvedDirectory(path.dirname(absolute)), path.basename(absolute)));
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
