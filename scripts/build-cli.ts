import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../abra-teleport');
const output = path.join(root, 'build');

async function copyAssets(directory: string): Promise<void> {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) await copyAssets(relative);
    else if (/\.(json|sh|md)$/.test(entry.name)) {
      await mkdir(path.dirname(path.join(output, relative)), { recursive: true });
      await copyFile(path.join(root, relative), path.join(output, relative));
    }
  }
}

await rm(output, { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.json')], { stdio: 'inherit' });
for (const directory of ['adapters', 'scripts', 'skills']) await copyAssets(directory);
const source = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await writeFile(path.join(output, 'package.json'), JSON.stringify({ name: source.name, version: source.version,
  type: 'module', engines: source.engines, bin: { 'abra-teleport': 'bin/abra-teleport.js' } }, null, 2));
for (const file of ['bin/abra-teleport.js', 'adapters/teleport-agent/bin/adapter.js']) {
  await chmod(path.join(output, file), 0o755);
}
