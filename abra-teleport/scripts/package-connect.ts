import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appRoot } from '../src/paths.js';

const base = process.env.ABRA_TELEPORT_RELEASE_URL || 'https://github.com/Lasdw6/AbraApp/releases/download/v0.3.0-rc.1';
const output = path.resolve(appRoot, '../dist');
if (base) {
  const url = new URL(base.replace(/\/?$/, '/'));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Release URL must be an HTTPS directory URL.');
  const archive = await readFile(path.join(output, 'abra-teleport-agent.tar.gz'));
  const digest = createHash('sha256').update(archive).digest('hex');
  const script = (await readFile(path.join(appRoot, 'scripts/connect.sh'), 'utf8'))
    .replace('@ARCHIVE_URL@', new URL('abra-teleport-agent.tar.gz', url).href.replaceAll("'", '%27'))
    .replace('@ARCHIVE_SHA256@', digest);
  await writeFile(path.join(output, 'connect.sh'), script, { mode: 0o755 });
  await writeFile(path.join(output, 'install.json'), JSON.stringify({ install_url: process.env.ABRA_TELEPORT_INSTALL_URL || 'https://abra.vividh.lol/install.sh' }, null, 2));
} else {
  await writeFile(path.join(output, 'install.json'), '{}\n');
}
