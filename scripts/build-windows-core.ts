import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { guardCommand } from './disk-guard.js';
import { GiB, requireDiskSpace } from '../abra-teleport/src/disk-space.js';

if (process.platform !== 'win32') throw new Error('Build the native Windows runtime on Windows with Rust MSVC and Visual Studio C++ Build Tools.');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = path.join(repo, 'abra');
const patch = path.join(repo, 'patches/abra-windows.patch');
const directories = [repo, os.tmpdir(), process.env.CARGO_TARGET_DIR || path.join(core, 'target'), process.env.CARGO_HOME || path.join(os.homedir(), '.cargo')];
for (const directory of directories) await requireDiskSpace(directory, 8 * GiB);
execFileSync('git', ['submodule', 'update', '--init', '--recursive'], { cwd: repo, stdio: 'inherit' });
const applied = spawnSync('git', ['apply', '--ignore-space-change', '--reverse', '--check', patch], { cwd: core, windowsHide: true });
if (applied.status !== 0) {
  execFileSync('git', ['apply', '--ignore-space-change', '--check', patch], { cwd: core, stdio: 'inherit' });
  execFileSync('git', ['apply', '--ignore-space-change', patch], { cwd: core, stdio: 'inherit' });
}
await guardCommand('cargo', ['build', '--locked', '--manifest-path', path.join(core, 'Cargo.toml'), '-p', 'abra-cli',
  ...(process.argv.includes('--release') ? ['--release'] : [])], { directories });
