import path from 'node:path';
import { appRoot } from './paths.js';
import { readJson } from './util.js';
import { isPairingCode } from './pairing-code.js';

export function connectionCommand(ticket, installUrl) {
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  if (!installUrl) return { command: `abra-teleport agent connect ${quote(ticket)}`, installs_cli: false };
  const url = new URL(installUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Installer URL must be an HTTPS download URL.');
  if (isPairingCode(ticket) && /^https:\/\/[A-Za-z0-9./_-]+$/.test(url.href)) {
    const script = `curl -fsSL ${url.href} | bash -s -- ${ticket}`;
    return { command: `bash -o pipefail -c ${quote(script)}`, installs_cli: true };
  }
  const script = `curl -fsSL --proto '=https' --proto-redir '=https' ${quote(url.href)} | bash -s -- "$1"`;
  return { command: `bash -o pipefail -c ${quote(script)} -- ${quote(ticket)}`, installs_cli: true };
}

export async function installerUrl() {
  const release = await readJson(path.join(appRoot, 'runtime', 'install.json'), {});
  return process.env.ABRA_TELEPORT_INSTALL_URL || release.install_url;
}
