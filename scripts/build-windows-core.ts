import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { guardCommand } from './disk-guard.js';
import { requireAbraPin } from './check-abra-pin.js';
import { GiB, requireDiskSpace } from '../abra-teleport/src/disk-space.js';

if (process.platform !== 'win32') throw new Error('Build the native Windows runtime on Windows with Rust MSVC and Visual Studio C++ Build Tools.');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = path.join(repo, 'abra');
const triple = 'x86_64-pc-windows-msvc';
const prepareOnly = process.argv.includes('--prepare-only');
const release = process.argv.includes('--release');
const profile = release ? 'release' : 'debug';
const directories = [repo, os.tmpdir(), process.env.CARGO_TARGET_DIR || path.join(core, 'target'), process.env.CARGO_HOME || path.join(os.homedir(), '.cargo')];

function capture(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '');
}

// Windows support is upstream now; nothing is patched here. Fail early and
// clearly when the pinned submodule is missing or predates that support.
function verifySubmodule() {
  requireAbraPin();
  if (!existsSync(path.join(core, 'Cargo.toml'))) {
    console.error('abra submodule is not initialized; run: git submodule update --init --recursive');
    process.exit(1);
  }
}

function verifyToolchain() {
  if (!capture('cargo', ['--version'])) throw new Error('Rust was not found. Install Rust 1.91+ with the MSVC toolchain, then reopen the terminal.');
  const installed = capture('rustup', ['target', 'list', '--installed']);
  if (installed && !installed.split(/\r?\n/).map(line => line.trim()).includes(triple)) {
    throw new Error(`Rust target ${triple} is not installed. Run: rustup target add ${triple}`);
  }
  if (!capture('link', ['/?']) && !process.env.VCINSTALLDIR && !existsSync(path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Microsoft Visual Studio'))) {
    console.warn('Visual Studio Build Tools with "Desktop development with C++" were not detected; the MSVC linker may be missing.');
  }
}

// Consumers (the packager, the Electron runtime resolver, and the CLI binary
// lookup) read abra/target/<profile>/abra.exe. An explicit --target writes to
// abra/target/<triple>/<profile>/, so publish the binary at both paths.
function publishBinary() {
  const built = path.join(core, 'target', triple, profile, 'abra.exe');
  const expected = path.join(core, 'target', profile, 'abra.exe');
  if (!existsSync(built)) throw new Error(`cargo did not produce ${built}`);
  mkdirSync(path.dirname(expected), { recursive: true });
  copyFileSync(built, expected);
  console.log(`Native Windows engine: ${expected}`);
}

verifySubmodule();
verifyToolchain();
if (prepareOnly) {
  console.log(`Ready to build the native Windows engine for ${triple}.`);
} else {
  for (const directory of directories) await requireDiskSpace(directory, 8 * GiB);
  await guardCommand('cargo', ['build', '--locked', '--manifest-path', path.join(core, 'Cargo.toml'), '-p', 'abra-cli',
    '--target', triple, ...(release ? ['--release'] : [])], { directories });
  publishBinary();
}
