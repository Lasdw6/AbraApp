import { build, Platform, Arch } from 'electron-builder';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const desktop = path.resolve(__dirname, '..');
const repo = path.dirname(desktop);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The native Windows installer currently targets Windows x64.');
  const binary = path.join(repo, 'abra/target/release/abra.exe');
  const bytes = await fs.readFile(binary);
  const pe = bytes.length >= 64 ? bytes.readUInt32LE(60) : 0;
  if (bytes.toString('ascii', 0, 2) !== 'MZ' || pe + 6 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664) {
    throw new Error('Expected a native Windows x64 Abra PE executable.');
  }
  // Export the same Linux sandbox installer pinned by the checked-in bootstrap.
  const bootstrap = await fs.readFile(path.join(repo, 'docs/install.sh'), 'utf8');
  const url = bootstrap.match(/ARCHIVE_URL='(https:[^']+)'/)?.[1];
  const expected = bootstrap.match(/EXPECTED='([a-f0-9]{64})'/)?.[1];
  if (!url || !expected) throw new Error('The checked-in agent bootstrap is missing its release URL or SHA-256.');
  const dist = path.join(repo, 'abra-teleport/dist');
  await fs.mkdir(dist, { recursive: true });
  const archive = path.join(dist, 'abra-teleport-agent.tar.gz');
  let agent = await fs.readFile(archive).catch(() => null);
  if (!agent || digest(agent) !== expected) {
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Agent download failed: HTTP ${response.status}`);
    agent = Buffer.from(await response.arrayBuffer());
    if (digest(agent) !== expected) throw new Error('Agent archive checksum mismatch.');
    await fs.writeFile(archive, agent);
  }
  await fs.writeFile(path.join(dist, 'install.json'), JSON.stringify({ install_url: 'https://abra.vividh.lol/install.sh' }));
  const pkg = JSON.parse(await fs.readFile(path.join(desktop, 'package.json'), 'utf8'));
  const extraResources = pkg.build.extraResources.map((resource: { from: string; to: string }) => resource.to === 'Runtime/abra'
    ? { from: binary, to: 'Runtime/abra.exe' } : resource);
  const output = path.join(desktop, 'dist/windows-native');
  await fs.mkdir(output, { recursive: true });
  const config = path.join(output, 'builder.json');
  await fs.writeFile(config, JSON.stringify({ ...pkg.build, extraResources,
    directories: { output },
    win: { ...pkg.build.win, target: 'nsis', executableName: 'Abra Teleport', signExecutable: false },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
      artifactName: 'Abra-Teleport-Windows-${version}-${arch}-Setup.${ext}' },
  }));
  await build({ projectDir: desktop, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), config });
  const packaged = await fs.readFile(path.join(output, 'win-unpacked/resources/Runtime/abra.exe'));
  if (digest(packaged) !== digest(bytes)) throw new Error('Packaged native engine checksum mismatch.');
  console.log(`Native Windows installer: ${output}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
