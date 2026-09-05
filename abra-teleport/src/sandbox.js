// Consumer handoffs use Abra peers. The sandbox owns its runtime and credentials.
import { agentRemote } from './agent.js';
import { browserPrepare, browserClose, browserRevoke, browserSend, browserReceive } from './browser.js';
import { codexSend, codexReceive, codexInspect } from './codex.js';
import { ensureDaemon } from './abra.js';
import { loadState } from './state.js';
import { paths } from './paths.js';
import { readJson, writeJson } from './util.js';
import path from 'node:path';

function result(raw, field) {
  try { return JSON.parse(raw); } catch { /* commands can emit progress first */ }
  for (const line of raw.split('\n')) {
    try { const value = JSON.parse(line); if (field in value) return value; } catch { /* next */ }
  }
  throw new Error('The agent returned an unreadable result.');
}

export async function sandboxCommand(action, config, payload = {}) {
  const activeFile = path.join(paths().home, 'handoff.json');
  const active = await readJson(activeFile, {});
  if (active.agent && active.agent !== config.id) throw new Error('Bring back the active handoff before switching agents.');
  const remote = async args => agentRemote(config, args);
  const json = async args => result(await remote(args), 'completed');
  if (action === 'connect' || action === 'status') return { ...await json(['doctor']), active };
  if (action === 'browser-frame') return result(await remote(['browser', 'exec', '--', 'node', 'browser-cloud-screenshot.js']), 'image');
  if (action === 'browser-action') return result(await remote(['browser', 'exec', '--', 'node', 'browser-cloud-action.js', payload.domain]), 'changed');
  if (action === 'browser-input') return json(['browser', 'input', JSON.stringify(payload)]);
  if (action === 'browser-revoke') {
    const returned = await json(['browser', 'revoke']);
    await json(['browser', 'close', '--force']);
    await writeJson(activeFile, active.codex ? { agent: config.id, codex: active.codex } : {});
    return returned;
  }
  if (action === 'browser-up') {
    if ((await loadState()).browser.active_receipt) await browserRevoke();
    await browserClose({ force: true });
    const prepared = await browserPrepare(payload);
    const sent = await browserSend(config.peer_id, { 'all-domains': true });
    await json(['browser', 'receive', sent.snapshot_id]);
    await writeJson(activeFile, { ...active, agent: config.id, browser: { url: payload.url, title: payload.title,
      cookie_count: prepared.cookie_count, include_storage: payload['no-storage'] !== true } });
    await browserRevoke(); await browserClose({ force: true });
    return { ...prepared, transferred: true };
  }
  if (action === 'browser-down') {
    const local = await ensureDaemon();
    const sent = await json(['browser', 'down', local.peer_id, '--all-domains']);
    await browserReceive(sent.snapshot_id, { from: config.peer_id });
    await json(['browser', 'revoke']); await json(['browser', 'close', '--force']);
    await writeJson(activeFile, active.codex ? { agent: config.id, codex: active.codex } : {});
    return { returned: true };
  }
  if (action === 'codex-up') {
    const sent = await codexSend(config.peer_id, { session: payload.session, workspace: payload.workspace, 'confirm-workspace': true });
    await json(['codex', 'receive', sent.session_snapshot_id]);
    await writeJson(activeFile, { ...active, agent: config.id, codex: { session: payload.session, workspace: payload.workspace } });
    return json(['codex', 'inspect', payload.session]);
  }
  if (action === 'codex-inspect') return json(['codex', 'inspect', (await loadState()).codex.session_id]);
  if (action === 'codex-run') {
    await remote(['codex', 'run', payload.prompt, '--no-return']);
    return json(['codex', 'inspect', (await loadState()).codex.session_id]);
  }
  if (action === 'app-inspect') return json(['app', 'inspect']);
  if (action === 'codex-down') {
    const state = await loadState(), local = await ensureDaemon();
    const sent = await json(['codex', 'down', local.peer_id, '--confirm-workspace']);
    const returned = await codexReceive(sent.session_snapshot_id, { from: config.peer_id, workspace: state.codex.workspace });
    await writeJson(activeFile, active.browser ? { agent: config.id, browser: active.browser } : {});
    return { ...returned, details: await codexInspect(state.codex.session_id) };
  }
  throw new Error('Unknown agent operation.');
}
