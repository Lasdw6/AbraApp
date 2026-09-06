import { build, Platform, Arch } from 'electron-builder';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const desktop = path.resolve(__dirname, '..');
const repo = path.dirname(desktop);
const stage = path.join(desktop, 'dist/windows-wsl');
const nodeVersion = 'v22.23.2';
const nodeSHA = 'b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a';

async function main() {
  const binary = process.env.ABRA_LINUX_BIN || (process.platform === 'linux'
    ? path.join(repo, 'abra/target/release/abra')
    : path.join(repo, 'abra-teleport/dist/native/linux-x64/abra'));
  const bytes = await fs.readFile(binary);
  if (bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2 || bytes.readUInt16LE(18) !== 62) {
    throw new Error('ABRA_LINUX_BIN must be a Linux x64 Abra binary. A macOS binary cannot run under WSL.');
  }
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true });
  const nodeArchive = path.join(desktop, `dist/node-${nodeVersion}-linux-x64.tar.gz`);
  const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  let nodeBytes = await fs.readFile(nodeArchive).catch(() => null);
  if (!nodeBytes || digest(nodeBytes) !== nodeSHA) {
    execFileSync('curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https',
      `https://nodejs.org/dist/${nodeVersion}/node-${nodeVersion}-linux-x64.tar.gz`, '-o', nodeArchive], { stdio: 'inherit' });
    nodeBytes = await fs.readFile(nodeArchive);
  }
  if (digest(nodeBytes) !== nodeSHA) throw new Error('Node archive checksum mismatch.');
  const nodeDir = path.join(stage, 'node');
  await fs.mkdir(nodeDir);
  execFileSync('tar', ['-xzf', nodeArchive, '--strip-components=1', '-C', nodeDir]);
  // Do not replace the live docs/install.sh; it pins the published agent archive.
  execFileSync('bash', [path.join(repo, 'abra-teleport/scripts/package-agent.sh')], { stdio: 'inherit' });
  const pkg = JSON.parse(await fs.readFile(path.join(desktop, 'package.json'), 'utf8'));
  const extraResources = pkg.build.extraResources.map((resource: { from: string; to: string }) => resource.to === 'Runtime/abra'
    ? { from: binary, to: 'Runtime/abra' } : resource);
  extraResources.push({ from: nodeDir, to: 'Runtime/node' });
  // An explicit config file avoids merging the macOS resource list from
  // package.json. Two concurrent copies to Runtime/abra can corrupt the binary.
  const config = path.join(stage, 'builder.json');
  await fs.writeFile(config, JSON.stringify({ ...pkg.build, extraResources,
    linux: { icon: 'public/icon.png', executableName: 'abra-teleport', category: 'Development' },
    directories: { output: path.join(stage, 'build') } }));
  await build({ projectDir: desktop, targets: Platform.LINUX.createTarget(['dir'], Arch.x64), config });
  const packaged = await fs.readFile(path.join(stage, 'build/linux-unpacked/resources/Runtime/abra'));
  if (digest(packaged) !== digest(bytes)) throw new Error('The packaged Abra binary differs from its source.');
  const bundle = path.join(stage, 'Abra-Teleport-Windows-WSL');
  await fs.mkdir(bundle);
  const archive = path.join(bundle, 'app.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', path.join(stage, 'build/linux-unpacked'), '.'],
    { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  for (const file of ['Setup-Windows.ps1', 'install-wsl.sh', 'launch-wsl.sh']) {
    await fs.copyFile(path.join(repo, 'scripts', file), path.join(bundle, file));
  }
  await fs.copyFile(path.join(repo, 'WINDOWS-WSL.md'), path.join(bundle, 'README.md'));
  await fs.copyFile(path.join(desktop, 'assets/icon.ico'), path.join(bundle, 'icon.ico'));
  const hashes: Record<string, string> = {};
  for (const file of ['app.tar.gz', 'install-wsl.sh', 'launch-wsl.sh', 'icon.ico']) hashes[file] = digest(await fs.readFile(path.join(bundle, file)));
  await fs.writeFile(path.join(bundle, 'manifest.json'), JSON.stringify({ version: pkg.version, arch: 'x64', sha256: hashes }, null, 2));
  const output = path.join(desktop, 'dist/Abra-Teleport-Windows-WSL-x64.zip');
  await fs.rm(output, { force: true });
  execFileSync('zip', ['-qr', output, path.basename(bundle)], { cwd: stage });
  console.log(output);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
