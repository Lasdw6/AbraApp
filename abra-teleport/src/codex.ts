import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, rename, rm, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { acquireTransferLock, acquireWriterLock, exportSession, findSession, importSession, listSessions, scanSecrets, sessionCheckpointFile } from '../adapters/codex-session/lib/session.js';
import { abra, ensureDaemon, ensurePrivateMaterialization, waitForAck } from './abra.js';
import { chooseInbox } from './inbox.js';
import { observe } from './observer.js';
import { paths } from './paths.js';
import { loadState, updateState } from './state.js';
import { executableOnPath, exists, readJson, runInteractive, secureDir, sleep } from './util.js';

import type { WorkspaceFinding } from './types.js';

const KIND = 'dev.abra.codex.session.v1';

export function codexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

async function codexBinary() {
  const candidate = process.env.CODEX_BIN || await executableOnPath('codex');
  if (!candidate) throw new Error('Codex was not found. Set CODEX_BIN');
  return candidate;
}

async function sessionSelection(requested) {
  const sessions = await listSessions(codexHome());
  if (!sessions.length) throw new Error(`no resumable Codex sessions found under ${codexHome()}`);
  if (!requested || requested === 'last') return sessions[0];
  const file = await findSession(codexHome(), requested);
  const selected = sessions.find(item => item.file === file);
  if (!selected) throw new Error('The selected Codex session is no longer available.');
  return selected;
}

function hashField(hash, value) {
  const bytes = Buffer.from(String(value));
  hash.update(String(bytes.length));
  hash.update(':');
  hash.update(bytes);
  hash.update('\0');
}

async function hashWorkspaceEntry(hash, root, file) {
  const info = await lstat(file);
  const relative = path.relative(root, file).split(path.sep).join('/');
  if (relative === '.abra' || relative.startsWith('.abra/')) return;
  if (info.isSymbolicLink()) {
    hashField(hash, 'link'); hashField(hash, relative); hashField(hash, info.mode & 0o777); hashField(hash, await readlink(file));
    return;
  }
  if (info.isDirectory()) {
    hashField(hash, 'directory'); hashField(hash, relative); hashField(hash, info.mode & 0o777);
    const entries = (await readdir(file)).sort();
    for (const name of entries) await hashWorkspaceEntry(hash, root, path.join(file, name));
    return;
  }
  if (info.isFile()) {
    hashField(hash, 'file'); hashField(hash, relative); hashField(hash, info.mode & 0o777); hashField(hash, info.size);
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    hash.update('\0');
    return;
  }
  throw new Error(`workspace contains an unsupported file: ${file}`);
}

export async function workspaceDigest(workspace) {
  const root = path.resolve(workspace);
  const hash = createHash('sha256');
  await hashWorkspaceEntry(hash, root, root);
  return hash.digest('hex');
}

async function scanWorkspaceEntry(root, file, findings) {
  const info = await lstat(file);
  const relative = path.relative(root, file).split(path.sep).join('/') || '.';
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    for (const name of (await readdir(file)).sort()) await scanWorkspaceEntry(root, path.join(file, name), findings);
    return;
  }
  if (!info.isFile()) return;
  const basename = path.basename(file).toLowerCase();
  if ((basename === '.env' || (basename.startsWith('.env.') && !/\.(?:example|sample|template)$/.test(basename)))) findings.push({ category: 'environment-file', path: relative });
  if (/^(?:id_rsa|id_ed25519|credentials)$/.test(basename) || /\.(?:pem|p12|pfx|key)$/.test(basename)) findings.push({ category: 'credential-file', path: relative });
  if (info.size <= 2 * 1024 * 1024) {
    for (const finding of scanSecrets(await readFile(file))) findings.push({ category: finding.category, path: relative, line: finding.line });
  }
}

export async function workspaceSecretFindings(workspace) {
  const root = path.resolve(workspace);
  const findings: WorkspaceFinding[] = [];
  await scanWorkspaceEntry(root, root, findings);
  return findings;
}

async function workspaceSnapshot(workspace) {
  const resolved = path.resolve(workspace);
  const info = await stat(resolved).catch(error => { throw new Error(`workspace cannot be read: ${error.message}`); });
  if (!info.isDirectory()) throw new Error('workspace must be a directory');
  const capsuleFile = path.join(resolved, '.abra', 'capsule_id');
  if (!await exists(capsuleFile)) await abra(['init', resolved]);
  const before = await workspaceDigest(resolved);
  const observation = await observe(resolved);
  let snapshot;
  try { snapshot = await abra(['snapshot', '-m', 'codex handoff', resolved,
    ...(observation ? ['--observation-barrier', observation.barrier] : [])]); }
  finally { await observation?.cleanup(); }
  const after = await workspaceDigest(resolved);
  if (before !== after) throw new Error('workspace changed while Abra was taking its snapshot');
  return { workspace: resolved, workspace_digest: after, ...snapshot };
}

function visibleSessionMessage(record) {
  if (record?.type !== 'event_msg') return null;
  const role = record.payload?.type === 'user_message'
    ? 'user'
    : record.payload?.type === 'agent_message'
      ? 'assistant'
      : null;
  const text = typeof record.payload?.message === 'string' ? record.payload.message.trim() : '';
  return role && text ? { role, text } : null;
}

async function lastUserPrompt(file, bytes, limit = 512 * 1024) {
  const handle = await open(file, 'r');
  try {
    const start = Math.max(0, bytes - limit);
    const buffer = Buffer.alloc(bytes - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start) lines.shift();
    for (let index = lines.length - 1; index >= 0; index--) {
      try {
        const message = visibleSessionMessage(JSON.parse(lines[index]));
        if (message?.role === 'user') return message.text.slice(0, 240);
      } catch { /* A partial or non-JSON line is not a visible message. */ }
    }
    return null;
  } finally { await handle.close(); }
}

export async function codexSessions() {
  const sessions = await listSessions(codexHome());
  const previews = await Promise.all(sessions.slice(0, 50).map(async session => {
    let activeWriter: boolean | null = null;
    try {
      const lock = await acquireWriterLock(codexHome(), session.session_id);
      await lock.release();
      activeWriter = false;
    } catch (error) {
      if (error.code === 'busy') activeWriter = true;
    }
    return {
      ...session,
      last_prompt: await lastUserPrompt(session.file, session.bytes).catch(() => null),
      workspace_exists: await stat(session.cwd).then(info => info.isDirectory()).catch(() => false),
      active_writer: activeWriter
    };
  }));
  return [...previews, ...sessions.slice(50)];
}

export async function codexInspect(requested) {
  const selected = await sessionSelection(requested);
  const messages: Array<{ role: string; text: string }> = [];
  let userTurns = 0;
  let assistantMessages = 0;
  const lines = createInterface({ input: createReadStream(selected.file), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const message = visibleSessionMessage(JSON.parse(line));
      if (!message) continue;
      if (message.role === 'user') userTurns += 1;
      else assistantMessages += 1;
      messages.push({ ...message, text: message.text.slice(0, 1200) });
      if (messages.length > 10) messages.shift();
    } catch { /* Invalid records are rejected during the actual handoff. */ }
  }
  return {
    session_id: selected.session_id,
    cwd: selected.cwd,
    updated_at: selected.updated_at,
    bytes: selected.bytes,
    user_turns: userTurns,
    assistant_messages: assistantMessages,
    messages
  };
}

export async function codexSend(peer, flags, direction = 'up') {
  await ensureDaemon();
  const state = await loadState();
  const selected = await sessionSelection(flags.session || state.codex.session_id);
  if (state.codex.session_id === selected.session_id && state.codex.location === 'away' && flags.force !== true) {
    throw new Error('this Codex session is marked away; receive it back before sending again, or pass --force after checking for divergence');
  }
  const destinationPeer = peer || state.codex.peer;
  if (!destinationPeer) throw new Error(`codex ${direction} needs a peer id`);
  const workspace = path.resolve(flags.workspace || state.codex.workspace || selected.cwd);
  if (flags['confirm-workspace'] !== true) throw new Error('pass --confirm-workspace to acknowledge that Abra will send the complete workspace');
  const transferLock = await acquireTransferLock(codexHome(), selected.session_id);
  const previousState = state.codex;
  let preflight;
  try {
    await updateState(current => { current.codex = { ...previousState, session_id: selected.session_id, workspace, peer: destinationPeer, location: 'transferring' }; });
    const findings = await workspaceSecretFindings(workspace);
    if (findings.length && flags['allow-workspace-secrets'] !== true) {
      const summary = findings.slice(0, 12).map(item => `${item.category}@${item.path}${item.line ? `:${item.line}` : ''}`).join(', ');
      throw new Error(`workspace may contain secrets (${summary}); clean it or pass --allow-workspace-secrets only if intended`);
    }
    await secureDir(paths().home);
    preflight = await mkdtemp(path.join(paths().home, 'codex-preflight-'));
    await exportSession({
      source: { session_id: selected.session_id, codex_home: codexHome() },
      staging_dir: preflight,
      options: { lock_nonce: transferLock.nonce, ...(flags['allow-secrets'] === true ? { allow_secrets: 'true' } : {}) }
    });
    await rm(preflight, { recursive: true, force: true });
    preflight = null;

    const workspaceAncestor = previousState.location === 'local' && previousState.session_id === selected.session_id
      ? previousState.workspace_snapshot_id
      : undefined;
    const snapshot = await workspaceSnapshot(workspace);
    const workspaceSent = await abra(['send', destinationPeer, '--capsule', snapshot.snapshot_id]);
    await waitForAck(workspaceSent.snapshot_id, Number(flags.timeout || 120000));
    const source = JSON.stringify({
      session_id: selected.session_id,
      codex_home: codexHome(),
      workspace_snapshot_id: snapshot.snapshot_id,
      workspace_capsule_id: snapshot.capsule_id,
      ...(workspaceAncestor ? { workspace_ancestor_snapshot_id: workspaceAncestor } : {}),
      workspace_name: path.basename(workspace)
    });
    const sessionArgs = ['send', destinationPeer, '--kind', KIND, '--source', source, '--adapter-option', `lock_nonce=${transferLock.nonce}`];
    if (flags['allow-secrets'] === true) sessionArgs.push('--adapter-option', 'allow_secrets=true');
    const sessionSent = await abra(sessionArgs);
    await waitForAck(sessionSent.snapshot_id, Number(flags.timeout || 120000));

    await updateState(current => {
      current.codex = {
        session_id: selected.session_id,
        workspace,
        capsule_id: snapshot.capsule_id,
        workspace_snapshot_id: snapshot.snapshot_id,
        workspace_digest: snapshot.workspace_digest,
        session_snapshot_id: sessionSent.snapshot_id,
        peer: destinationPeer,
        direction,
        location: 'away',
        sent_at: new Date().toISOString()
      };
    });
    return {
      direction,
      peer: destinationPeer,
      session_id: selected.session_id,
      workspace,
      capsule_id: snapshot.capsule_id,
      workspace_snapshot_id: snapshot.snapshot_id,
      session_snapshot_id: sessionSent.snapshot_id,
      state: 'acked'
    };
  } catch (error) {
    await updateState(current => { current.codex = { ...previousState, last_error: error.message, location: previousState.location || 'local' }; }).catch(() => {});
    throw error;
  } finally {
    if (preflight) await rm(preflight, { recursive: true, force: true }).catch(() => {});
    await transferLock.release();
  }
}

async function waitForWorkspace(capsuleId, snapshotId, timeoutMs, expectedAncestor) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let log;
    try {
      log = await abra(['log', '--capsule', capsuleId]);
    } catch { /* The full capsule may still be transferring. */ }
    const row = log?.find(item => item.snapshot_id === snapshotId);
    if (row) {
      if (expectedAncestor && !row.parents?.includes(expectedAncestor)) {
        throw new Error('workspace snapshot does not descend from the local handoff checkpoint');
      }
      const capsules = await abra(['capsules']);
      const capsule = capsules.find(item => item.capsule_id === capsuleId);
      if (!capsule?.heads?.includes(snapshotId)) throw new Error('workspace snapshot is not a current capsule head');
      return row;
    }
    await sleep(250);
  }
  throw new Error(`workspace snapshot ${snapshotId} did not arrive within ${timeoutMs}ms`);
}

async function preflightWorkspaceTarget(manifest, workspace, prior) {
  const target = path.resolve(workspace);
  const capsuleFile = path.join(target, '.abra', 'capsule_id');
  if (await exists(capsuleFile)) {
    const current = (await readFile(capsuleFile, 'utf8')).trim();
    if (current !== manifest.workspace_capsule_id) throw new Error(`workspace belongs to capsule ${current}, not ${manifest.workspace_capsule_id}`);
    if (prior.codex.workspace !== target || prior.codex.capsule_id !== current) {
      throw new Error('workspace is not tracked by this wrapper; refusing to replace it');
    }
    return target;
  }
  const entries = await readdir(target).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  if (entries.length) throw new Error(`workspace destination is not empty: ${target}`);
  return target;
}

async function stageWorkspace(manifest, target, expectedAncestor, timeoutMs) {
  await waitForWorkspace(manifest.workspace_capsule_id, manifest.workspace_snapshot_id, timeoutMs, expectedAncestor);
  await mkdir(path.dirname(target), { recursive: true });
  const staged = path.join(path.dirname(target), `.abra-teleport-stage-${path.basename(target)}-${Date.now()}-${process.pid}`);
  await abra(['accept', manifest.workspace_snapshot_id, staged]);
  const capsule = (await readFile(path.join(staged, '.abra', 'capsule_id'), 'utf8')).trim();
  const snapshot = (await readFile(path.join(staged, '.abra', 'snapshot_id'), 'utf8')).trim();
  if (capsule !== manifest.workspace_capsule_id || snapshot !== manifest.workspace_snapshot_id) {
    await rm(staged, { recursive: true, force: true });
    throw new Error('staged workspace metadata does not match the Codex handoff');
  }
  return staged;
}

async function existingSessionFile(home, sessionId) {
  try { return await findSession(home, sessionId); }
  catch (error) { if (error.code === 'not_found') return null; throw error; }
}

async function backupSession(home, manifest, directory) {
  const target = path.resolve(home, ...manifest.relative_path.split('/'));
  const existing = await existingSessionFile(home, manifest.session_id);
  if (existing && path.resolve(existing) !== target) throw new Error('received rollout path does not match the existing session UUID');
  const checkpoint = sessionCheckpointFile(home, manifest.session_id);
  const result = { target, checkpoint, sessionExisted: Boolean(existing), checkpointExisted: await exists(checkpoint) };
  if (result.sessionExisted) await copyFile(target, path.join(directory, 'session.jsonl'));
  if (result.checkpointExisted) await copyFile(checkpoint, path.join(directory, 'checkpoint.json'));
  return result;
}

async function restoreSession(backup, directory) {
  await rm(backup.target, { force: true });
  await rm(backup.checkpoint, { force: true });
  if (backup.sessionExisted) {
    await mkdir(path.dirname(backup.target), { recursive: true, mode: 0o700 });
    await copyFile(path.join(directory, 'session.jsonl'), backup.target);
    await chmod(backup.target, 0o600);
  }
  if (backup.checkpointExisted) {
    await mkdir(path.dirname(backup.checkpoint), { recursive: true, mode: 0o700 });
    await copyFile(path.join(directory, 'checkpoint.json'), backup.checkpoint);
    await chmod(backup.checkpoint, 0o600);
  }
}

export async function codexReceive(requestedId, flags) {
  await ensureDaemon();
  if (!flags.workspace) throw new Error('codex receive needs --workspace <path>');
  const prior = await loadState();
  const workspacePath = path.resolve(flags.workspace);
  let expectedWorkspaceAncestor;
  if (prior.codex.location === 'away' && prior.codex.workspace === workspacePath) {
    if (!prior.codex.workspace_digest || await workspaceDigest(workspacePath) !== prior.codex.workspace_digest) {
      throw new Error('local workspace changed while the Codex session was away; refusing to overwrite it');
    }
    expectedWorkspaceAncestor = prior.codex.workspace_snapshot_id;
  }
  const item = await chooseInbox(KIND, requestedId, flags.from);
  const materialized = await ensurePrivateMaterialization(item.id);
  const destination = JSON.stringify({
    codex_home: codexHome(),
    workspace: workspacePath,
    ...(expectedWorkspaceAncestor ? { expected_workspace_ancestor: expectedWorkspaceAncestor } : {})
  });
  const adapterOptions = flags['allow-version-mismatch'] === true ? { allow_version_mismatch: 'true' } : {};
  let stagedWorkspace;
  let workspaceBackup;
  let sessionBackup;
  let transferLock;
  let workspaceCommitted = false;
  let stateCommitted = false;
  const transaction = await mkdtemp(path.join(paths().home, 'codex-receive-'));
  try {
    const stageOptions = ['--no-import'];
    if (flags['allow-version-mismatch'] === true) stageOptions.push('--adapter-option', 'allow_version_mismatch=true');
    await abra(['accept', item.id, materialized, '--destination', destination, ...stageOptions]);
    const manifest = await readJson(path.join(materialized, 'manifest.json'));
    if (manifest.kind !== KIND || !manifest.workspace_snapshot_id || !manifest.workspace_capsule_id) throw new Error('received Codex handoff does not include a workspace snapshot');
    const workspace = await preflightWorkspaceTarget(manifest, workspacePath, prior);
    stagedWorkspace = await stageWorkspace(manifest, workspace, expectedWorkspaceAncestor, Number(flags.timeout || 120000));
    await abra(['lease', 'take', manifest.workspace_capsule_id]);

    transferLock = await acquireTransferLock(codexHome(), manifest.session_id);
    sessionBackup = await backupSession(codexHome(), manifest, transaction);
    if (await exists(workspace)) {
      workspaceBackup = path.join(path.dirname(workspace), `.abra-teleport-backup-${path.basename(workspace)}-${Date.now()}-${process.pid}`);
      await rename(workspace, workspaceBackup);
    }
    await rename(stagedWorkspace, workspace);
    stagedWorkspace = null;
    workspaceCommitted = true;
    await importSession({
      materialized_files: materialized,
      destination: { codex_home: codexHome(), workspace, ...(expectedWorkspaceAncestor ? { expected_workspace_ancestor: expectedWorkspaceAncestor } : {}) },
      payload: manifest,
      options: { ...adapterOptions, lock_nonce: transferLock.nonce }
    });
    const digest = await workspaceDigest(workspace);
    await updateState(state => {
      state.codex = {
        session_id: manifest.session_id,
        workspace,
        capsule_id: manifest.workspace_capsule_id,
        workspace_snapshot_id: manifest.workspace_snapshot_id,
        workspace_digest: digest,
        session_snapshot_id: item.id,
        peer: item.from,
        location: 'local',
        received_at: new Date().toISOString()
      };
    });
    stateCommitted = true;
    const cleanupWarnings: string[] = [];
    if (workspaceBackup) await rm(workspaceBackup, { recursive: true, force: true }).catch(cleanup => cleanupWarnings.push(`old workspace cleanup failed: ${cleanup.message}`));
    await rm(materialized, { recursive: true, force: true }).catch(cleanup => cleanupWarnings.push(`received bundle cleanup failed: ${cleanup.message}`));
    await rm(transaction, { recursive: true, force: true }).catch(cleanup => cleanupWarnings.push(`transaction cleanup failed: ${cleanup.message}`));
    return {
      accepted: item.id,
      from: item.from,
      session_id: manifest.session_id,
      workspace,
      workspace_snapshot_id: manifest.workspace_snapshot_id,
      resume: `codex resume ${manifest.session_id} -C ${workspace}`,
      ...(cleanupWarnings.length ? { warnings: cleanupWarnings } : {})
    };
  } catch (error) {
    if (stateCommitted) throw error;
    const rollbackErrors: string[] = [];
    if (sessionBackup) await restoreSession(sessionBackup, transaction).catch(rollback => rollbackErrors.push(`session rollback failed: ${rollback.message}`));
    if (workspaceCommitted) {
      await rm(workspacePath, { recursive: true, force: true }).catch(rollback => rollbackErrors.push(`workspace cleanup failed: ${rollback.message}`));
      if (workspaceBackup) await rename(workspaceBackup, workspacePath).catch(rollback => rollbackErrors.push(`workspace rollback failed: ${rollback.message}`));
    } else if (stagedWorkspace) {
      await rm(stagedWorkspace, { recursive: true, force: true }).catch(rollback => rollbackErrors.push(`staged workspace cleanup failed: ${rollback.message}`));
    }
    const suffix = rollbackErrors.length ? `; ${rollbackErrors.join('; ')}` : '';
    throw new Error(`${error.message}; retry handoff ${item.id}; received bundle kept at ${materialized}${suffix}`);
  } finally {
    if (transferLock) await transferLock.release().catch(() => {});
    await rm(transaction, { recursive: true, force: true }).catch(() => {});
  }
}

export async function codexRun(prompt, flags) {
  if (!prompt) throw new Error('codex run needs a prompt');
  const state = await loadState();
  if (state.codex.location !== 'local' || !state.codex.session_id || !state.codex.workspace) throw new Error('receive a Codex handoff before running it');
  if (flags['no-return'] !== true && flags['confirm-workspace'] !== true) {
    throw new Error('pass --confirm-workspace before running; the completed turn will send the complete workspace back');
  }
  const binary = await codexBinary();
  await runInteractive(binary, ['exec', '--sandbox', 'workspace-write', '-C', state.codex.workspace, 'resume', '--skip-git-repo-check', state.codex.session_id, prompt]);
  const peer = flags['return-to'] || state.codex.peer;
  if (flags['no-return'] === true) return { completed: true, returned: false, session_id: state.codex.session_id };
  return { completed: true, returned: true, handoff: await codexSend(peer, { ...flags, session: state.codex.session_id, workspace: state.codex.workspace }, 'down') };
}

export async function codexResume(flags) {
  const state = await loadState();
  if (state.codex.location !== 'local' || !state.codex.session_id || !state.codex.workspace) throw new Error('receive a Codex handoff before resuming it');
  if (flags['return-to'] && flags['confirm-workspace'] !== true) {
    throw new Error('pass --confirm-workspace before resuming; the completed turn will send the complete workspace back');
  }
  const binary = await codexBinary();
  await runInteractive(binary, ['resume', state.codex.session_id, '-C', state.codex.workspace]);
  if (!flags['return-to']) return { completed: true, returned: false, session_id: state.codex.session_id };
  return { completed: true, returned: true, handoff: await codexSend(flags['return-to'], { ...flags, session: state.codex.session_id, workspace: state.codex.workspace }, 'down') };
}

export async function codexStatus() {
  return (await loadState()).codex;
}
