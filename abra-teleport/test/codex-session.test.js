import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { acquireWriterLock, exportSession, importSession, scanSecrets } from '../adapters/codex-session/lib/session.js';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const TS = '2026-09-02T12-34-56';

function rollout(extra = []) {
  return [
    JSON.stringify({
      timestamp: '2026-09-02T12:34:56Z',
      type: 'session_meta',
      payload: {
        id: SESSION_ID,
        session_id: SESSION_ID,
        timestamp: '2026-09-02T12:34:56Z',
        cwd: '/work/demo',
        cli_version: '9.9.9',
        model_provider: 'openai',
        history_mode: 'full'
      }
    }),
    JSON.stringify({ timestamp: '2026-09-02T12:35:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'hello' } }),
    ...extra.map(message => JSON.stringify({ timestamp: '2026-09-02T12:36:00Z', type: 'event_msg', payload: { type: 'agent_message', message } }))
  ].join('\n') + '\n';
}

async function putSession(home, contents = rollout()) {
  const directory = path.join(home, 'sessions', '2026', '09', '02');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-${TS}-${SESSION_ID}.jsonl`);
  await writeFile(file, contents);
  return file;
}

async function adapterExport(home, staging, options = {}) {
  return exportSession({
    source: {
      session_id: SESSION_ID,
      codex_home: home,
      workspace_snapshot_id: 'a'.repeat(64),
      workspace_capsule_id: 'b'.repeat(64),
      workspace_name: 'demo'
    },
    staging_dir: staging,
    options
  });
}

async function adapterImport(bundle, home, payload) {
  return importSession({
    materialized_files: bundle,
    destination: { codex_home: home, workspace: '/work/demo' },
    payload,
    options: { skip_version_check: 'true' }
  });
}

test('Codex adapter round trip advances an unchanged ancestor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-teleport-codex-'));
  const local = path.join(root, 'local');
  const cloud = path.join(root, 'cloud');
  const firstBundle = path.join(root, 'first');
  const secondBundle = path.join(root, 'second');
  const localFile = await putSession(local);

  const first = await adapterExport(local, firstBundle);
  await adapterImport(firstBundle, cloud, first.payload);
  const relative = first.payload.relative_path.split('/');
  const cloudFile = path.join(cloud, ...relative);
  await writeFile(cloudFile, rollout(['cloud changed it']));

  const second = await adapterExport(cloud, secondBundle);
  await adapterImport(secondBundle, local, second.payload);
  assert.equal(await readFile(localFile, 'utf8'), rollout(['cloud changed it']));
  assert.equal((await stat(localFile)).mode & 0o777, 0o600);
  assert.equal(second.payload.ancestor_sha256, first.payload.sha256);
});

test('Codex adapter rejects divergent histories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-teleport-diverge-'));
  const local = path.join(root, 'local');
  const cloud = path.join(root, 'cloud');
  const firstBundle = path.join(root, 'first');
  const secondBundle = path.join(root, 'second');
  const localFile = await putSession(local);
  const first = await adapterExport(local, firstBundle);
  await adapterImport(firstBundle, cloud, first.payload);
  await writeFile(localFile, rollout(['local branch']));
  await writeFile(path.join(cloud, ...first.payload.relative_path.split('/')), rollout(['cloud branch']));
  const second = await adapterExport(cloud, secondBundle);
  await assert.rejects(adapterImport(secondBundle, local, second.payload), /diverged/);
  assert.equal(await readFile(localFile, 'utf8'), rollout(['local branch']));
});

test('Codex adapter secret scan reports only category and line', async () => {
  const fakeKey = `sk-${'x'.repeat(32)}`;
  const findings = scanSecrets(Buffer.from(`safe\n${fakeKey}\n`));
  assert.deepEqual(findings, [{ category: 'openai-key', line: 2 }]);

  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-teleport-secret-'));
  const home = path.join(root, 'home');
  await putSession(home, rollout([fakeKey]));
  await assert.rejects(adapterExport(home, path.join(root, 'bundle')), error => {
    assert.match(error.message, /openai-key@3/);
    assert.doesNotMatch(error.message, /sk-/);
    return true;
  });
});

test('Codex adapter refuses an active writer lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-teleport-lock-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  const bundle = path.join(root, 'bundle');
  await putSession(source);
  const exported = await adapterExport(source, bundle);
  const guard = await acquireWriterLock(destination, SESSION_ID);
  try { await assert.rejects(adapterImport(bundle, destination, exported.payload), /active writer/); }
  finally { await guard.release(); }
});

test('Codex adapter refuses the same UUID at a different rollout path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-teleport-path-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  const bundle = path.join(root, 'bundle');
  await putSession(source);
  await putSession(destination);
  const exported = await adapterExport(source, bundle);
  const manifestFile = path.join(bundle, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.relative_path = manifest.relative_path.replace('sessions/2026/09/02/', 'sessions/2099/01/01/');
  await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
  await assert.rejects(adapterImport(bundle, destination, { ...exported.payload, relative_path: manifest.relative_path }), /does not match the existing session UUID/);
});
