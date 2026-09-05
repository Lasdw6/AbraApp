import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { workspaceDigest, workspaceSecretFindings } from '../build/src/codex.js';
import { redact } from '../build/src/util.js';

test('workspace digest tracks content but ignores Abra metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-teleport-workspace-'));
  await writeFile(path.join(root, 'file.txt'), 'one\n');
  const first = await workspaceDigest(root);
  await mkdir(path.join(root, '.abra'));
  await writeFile(path.join(root, '.abra', 'snapshot_id'), 'a'.repeat(64));
  assert.equal(await workspaceDigest(root), first);
  await writeFile(path.join(root, 'file.txt'), 'two\n');
  assert.notEqual(await workspaceDigest(root), first);
});

test('workspace secret scan reports location without secret values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-teleport-workspace-secret-'));
  const fake = `sk-${'z'.repeat(32)}`;
  await writeFile(path.join(root, '.env'), `OPENAI_API_KEY=${fake}\n`);
  const findings = await workspaceSecretFindings(root);
  assert.deepEqual(findings, [
    { category: 'environment-file', path: '.env' },
    { category: 'openai-key', path: '.env', line: 1 }
  ]);
  assert.doesNotMatch(JSON.stringify(findings), /sk-/);
});

test('subprocess error redaction removes tickets, tokens, and URLs', () => {
  const input = `abra-pair/1/secret_ticket sk-${'x'.repeat(32)} https://example.com/private`;
  const output = redact(input);
  assert.doesNotMatch(output, /secret_ticket|sk-|example\.com/);
});
