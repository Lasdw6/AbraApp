import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { connectionCommand } from '../build/src/install.js';
const exec = promisify(execFile);
const template = await readFile(new URL('../scripts/connect.sh', import.meta.url), 'utf8');

test('connection command requires HTTPS and keeps the ticket out of the download URL', () => {
  const ticket = 'abra-pair/1/test';
  const output = connectionCommand(ticket, 'https://example.com/connect.sh');
  assert.equal(output.installs_cli, true);
  assert.ok(output.command.startsWith('bash -o pipefail -c '));
  assert.ok(output.command.endsWith("-- 'abra-pair/1/test'"));
  assert.throws(() => connectionCommand(ticket, 'http://example.com/install'));
  assert.throws(() => connectionCommand(ticket, 'https://user:secret@example.com/install'));
});

test('connection command fails when the installer download fails', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-bootstrap-download-'));
  try {
    await writeFile(path.join(root, 'curl'), '#!/bin/sh\nexit 22\n', { mode: 0o755 });
    const { command } = connectionCommand('abra-pair/1/test', 'https://example.com/connect.sh');
    await assert.rejects(exec('bash', ['-c', command], { env: { ...process.env, PATH: `${root}:/usr/bin:/bin` } }), error => error instanceof Error && 'code' in error && error.code === 22);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bootstrap upgrades an old CLI for short codes, reuses it, and rejects a corrupt archive', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-bootstrap-test-'));
  try {
    const bin = path.join(root, 'bin'), mock = path.join(root, 'mock'), staged = path.join(root, 'package/abra-teleport/scripts');
    await Promise.all([mkdir(bin), mkdir(mock), mkdir(staged, { recursive: true })]);
    await writeFile(path.join(staged, 'install-agent.sh'), `#!/bin/bash\nset -eu\nprintf '#!/bin/bash\\nif [[ "$1" == --help ]]; then echo "agent connect <ticket-or-code>"; else echo "$1 $2" >> "$PAIR_LOG"; fi\\n' > "$ABRA_TELEPORT_BIN_DIR/abra-teleport"\nchmod +x "$ABRA_TELEPORT_BIN_DIR/abra-teleport"\n`);
    const archive = path.join(root, 'archive.tar.gz');
    await exec('tar', ['-czf', archive, '-C', path.join(root, 'package'), 'abra-teleport']);
    await writeFile(path.join(mock, 'curl'), '#!/bin/bash\nset -eu\necho download >> "$DOWNLOAD_LOG"\nwhile [[ "$1" != -o ]]; do shift; done\ncp "$FIXTURE_ARCHIVE" "$2"\n', { mode: 0o755 });
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    const script = path.join(root, 'connect.sh');
    await writeFile(script, template.replace('@ARCHIVE_URL@', 'https://example.com/agent.tar.gz').replace('@ARCHIVE_SHA256@', digest));
    const env = { ...process.env, PATH: `${mock}:/usr/bin:/bin`, ABRA_TELEPORT_BIN_DIR: bin, PAIR_LOG: path.join(root, 'pairs'), DOWNLOAD_LOG: path.join(root, 'downloads'), FIXTURE_ARCHIVE: archive };
    await writeFile(path.join(bin, 'abra-teleport'), '#!/bin/bash\necho agent connect\n', { mode: 0o755 });
    await exec('bash', [script, 'ABRA-abcdefghijklmnopqrstuv'], { env });
    await exec('bash', [script, 'abra-pair/1/fixture'], { env });
    assert.equal((await readFile(env.DOWNLOAD_LOG, 'utf8')).trim(), 'download');
    assert.equal((await readFile(env.PAIR_LOG, 'utf8')).trim(), 'agent connect\nagent connect');
    await rm(path.join(bin, 'abra-teleport'));
    await writeFile(archive, 'corrupted');
    await assert.rejects(exec('bash', [script, 'abra-pair/1/fixture'], { env }), /checksum mismatch/);
    assert.equal((await readFile(env.PAIR_LOG, 'utf8')).trim(), 'agent connect\nagent connect');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('short-code commands remain compact, quote once, and preserve download failures', { skip: process.platform === 'win32' }, async () => {
  const code = 'ABRA-abcdefghijklmnopqrstuv';
  const { command } = connectionCommand(code, 'https://abra.vividh.lol/install.sh');
  assert.ok(command.length < 125);
  assert.ok(!command.includes("\\'"));
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-short-command-'));
  try {
    await writeFile(path.join(root, 'curl'), '#!/bin/sh\nexit 22\n', { mode: 0o755 });
    await assert.rejects(exec('bash', ['-c', command], { env: { ...process.env, PATH: `${root}:/usr/bin:/bin` } }), error => error instanceof Error && 'code' in error && error.code === 22);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed short-code CLI pairs without downloading again', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-short-reuse-'));
  try {
    const cli = path.join(root, 'abra-teleport');
    await writeFile(cli, '#!/bin/bash\nif [[ "$1" == --help ]]; then echo "agent connect <ticket-or-code>"; else printf "%s" "$3" > "$PAIR_LOG"; fi\n', { mode: 0o755 });
    const script = path.join(root, 'connect.sh');
    await writeFile(script, template);
    const code = 'ABRA-abcdefghijklmnopqrstuv';
    await exec('bash', [script, code], { env: { ...process.env, PATH: `${root}:/usr/bin:/bin`, PAIR_LOG: path.join(root, 'pair') } });
    assert.equal(await readFile(path.join(root, 'pair'), 'utf8'), code);
  } finally { await rm(root, { recursive: true, force: true }); }
});
