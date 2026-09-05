// Consumer handoffs use Abra peers. The sandbox owns its runtime and credentials.
import { agentRemote } from './agent.js';
import { browserPrepare, browserClose, browserRevoke, browserSend, browserReceive } from './browser.js';
import { abra, ensureDaemon } from './abra.js';
import { loadState } from './state.js';
import { browserSessions } from './browser-sessions.js';
import { paths } from './paths.js';
import { readJson, writeJson } from './util.js';
import path from 'node:path';
import type { AgentDescriptor } from './types.js';

function result(raw: string, field: string) {
  try { return JSON.parse(raw); } catch { /* commands can emit progress first */ }
  for (const line of raw.split('\n')) {
    try { const value = JSON.parse(line); if (field in value) return value; } catch { /* next */ }
  }
  throw new Error('The agent returned an unreadable result.');
}

export async function sandboxCommand(action: string, config: AgentDescriptor, payload: Record<string, any> = {}) {
  const activeFile = path.join(paths().home, 'handoff.json');
  const saved = await readJson(activeFile, {});
  let browsers = saved.browsers || (saved.browser ? [saved.browser] : []);
  if (browsers.length && saved.agent && saved.agent !== config.id) throw new Error('Bring back or revoke the active handoffs before switching agents.');
  const active = () => browsers.length ? { agent: config.id, browser: browsers.at(-1), browsers } : {};
  const save = () => writeJson(activeFile, active());
  const json = async (args, timeout = 540000) => result(await agentRemote(config, args, timeout), 'completed');
  const status = async () => {
    const value = await json(['browser', 'status'], 8000);
    if (!value.handoff) throw new Error('The sandbox could not confirm its browser sessions.');
    return value;
  };
  const migrate = async remote => {
    if (browsers.length === 1 && !browsers[0].id && remote.handoff.active_context_id) {
      browsers = [{ ...browsers[0], id: remote.handoff.active_context_id }];
      await save();
    }
  };
  const receive = async id => {
    if (!/^[a-f0-9]{64}$/.test(id || '')) throw new Error('Invalid incoming browser handoff.');
    const existing = browserSessions((await loadState()).browser).find(item => item.received_snapshot_id === id && item.from === config.peer_id);
    if (!existing) await browserReceive(id, { from: config.peer_id, headless: payload.headless === true });
  };
  if (action === 'status') return { active: active() };
  if (action === 'connect') return { ...await json(['doctor'], 8000), active: active() };
  if (action === 'browser-frame') return result(await agentRemote(config, ['browser', 'exec', '--', 'node', 'browser-cloud-screenshot.js']), 'image');
  if (action === 'browser-input') return json(['browser', 'input', JSON.stringify(payload)]);
  if (action === 'browser-tabs') return { tabs: (await json(['browser', 'available-tabs'])).map(({ source, ...tab }) => tab) };
  if (action === 'browser-incoming') {
    await ensureDaemon();
    const inbox = await abra(['inbox', '--kind', 'dev.abra.browser.session.v1']);
    return { incoming: inbox.filter(item => item.from === config.peer_id && !item.read).map(({ id, received_at }) => ({ id, received_at })) };
  }
  if (action === 'browser-accept') { await receive(payload.id); return { returned: true }; }
  if (action === 'browser-pull') {
    if (!/^[a-f0-9]{32}$/i.test(payload.tab_id || '')) throw new Error('Choose a sandbox tab.');
    const sent = await json(['browser', 'send-tab', payload.tab_id]);
    await receive(sent.snapshot_id);
    return { returned: true };
  }
  if (action === 'browser-up') {
    const remote = await status();
    await migrate(remote);
    if (browsers.length && !remote.multiple_sessions) throw new Error('Update the agent CLI to send additional tabs. The existing session is still active.');
    const prepared = await browserPrepare(payload);
    const context = (await loadState()).browser.active_context_id;
    try {
      const sent = await browserSend(config.peer_id, { 'all-domains': true, session: context });
      const received = await json(['browser', 'receive', sent.snapshot_id]);
      const session = { id: received.browser_context_id, url: payload.url, title: payload.title,
        cookie_count: prepared.cookie_count, include_storage: payload['no-storage'] !== true };
      browsers.push(session); await save();
      return { ...prepared, transferred: true, session };
    } finally {
      await browserRevoke(context);
      if (payload.profile !== 'active') await browserClose({ force: true });
    }
  }
  if (action === 'browser-down' || action === 'browser-revoke') {
    const remote = await status();
    await migrate(remote);
    if (!payload.session_id && browsers.length > 1) throw new Error('Choose which browser session to return or revoke.');
    const selected = payload.session_id ? browsers.find(item => item.id === payload.session_id) : browsers[0];
    if (payload.session_id && !selected) throw new Error('That handoff is no longer active. Refresh sessions.');
    const id = selected?.id || remote.handoff.active_context_id;
    const remoteSessions = remote.multiple_sessions ? remote.sessions : [remote.handoff];
    const exists = remoteSessions.some(item => item.active_receipt && item.active_context_id === id);
    const args = remote.multiple_sessions && id ? ['--session', id] : [];
    if (!remote.multiple_sessions && selected?.id && selected.id !== remote.handoff.active_context_id && remote.handoff.active_receipt) {
      throw new Error('The agent is showing a different session. Update its CLI before continuing.');
    }
    if (action === 'browser-down') {
      if (!exists) throw new Error('The sandbox session is no longer available to return.');
      const local = await ensureDaemon();
      const sent = await json(['browser', 'down', local.peer_id, '--all-domains', ...args]);
      await receive(sent.snapshot_id);
    }
    const revoked = exists ? await json(['browser', 'revoke', ...args], 20000) : { revoked: true, already_revoked: true };
    let cleanup_warning;
    // Keep the shared browser alive while any other imported session remains.
    if (!remote.multiple_sessions || remoteSessions.filter(item => item.active_receipt && item.active_context_id !== id).length === 0) {
      try { await json(['browser', 'close', '--force'], 8000); }
      catch { cleanup_warning = 'The session was removed, but the empty browser could not be closed.'; }
    }
    browsers = browsers.filter(item => item !== selected); await save();
    return action === 'browser-down' ? { returned: true } : { ...revoked, cleanup_warning };
  }
  throw new Error('Unknown agent operation.');
}
