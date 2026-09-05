import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function paths() {
  const home = path.resolve(process.env.ABRA_TELEPORT_HOME || path.join(os.homedir(), '.abra-teleport'));
  const abraRoot = path.resolve(process.env.ABRA_TELEPORT_ABRA_ROOT || path.join(home, 'abra'));
  const browserData = path.resolve(process.env.ABRA_BROWSER_DATA_DIR || (abraRoot === '/var/lib/abra'
    ? '/var/lib/abra/browser-session-data'
    : path.join(home, 'browser-adapter')));
  return {
    home,
    abraRoot,
    browserData,
    chromeProfile: path.join(home, 'chrome-profile'),
    chromeState: path.join(home, 'chrome.json'),
    daemonState: path.join(home, 'daemon.json'),
    daemonLog: path.join(home, 'daemon.log'),
    state: path.join(home, 'state.json'),
    received: path.join(home, 'received'),
    codexAdapter: path.join(appRoot, 'adapters', 'codex-session')
  };
}

export function browserAdapterCandidates() {
  return [
    process.env.ABRA_BROWSER_ADAPTER,
    path.join(appRoot, 'runtime/browser-session'),
    path.resolve(appRoot, '..', 'abra', 'adapters', 'browser-session'),
    path.resolve(appRoot, '../..', 'abra/adapters/browser-session'),
    '/var/lib/abra/adapters/browser-session'
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}
