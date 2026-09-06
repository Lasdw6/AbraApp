import { useEffect, useRef, useState } from 'react';
import type { ConnectionHealth } from '../shared/contracts';

function message(error: unknown) { return error instanceof Error ? error.message : String(error); }

function AgentName({ agent, onRenamed }: { agent: ProviderConfig; onRenamed: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const cancel = () => { setEditing(false); setError(''); };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setError('');
    try { await window.abra!.agentRename(agent.id, name); await onRenamed(); setEditing(false); }
    catch (error) { setError(message(error)); }
    finally { setSaving(false); }
  };
  return <div className="agent-name">
    {editing ? <form onSubmit={save} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (!saving) cancel(); } }}>
      <input aria-label="Agent name" autoFocus maxLength={80} value={name} disabled={saving} onChange={event => setName(event.target.value)} />
      <button type="submit" disabled={saving || !name.trim()}>{saving ? 'Saving…' : 'Save'}</button>
      <button type="button" className="link" disabled={saving} onClick={cancel}>Cancel</button>
    </form> : <div><strong>{agent.name}</strong><button className="link" aria-label={`Rename ${agent.name}`} onClick={() => { setName(agent.name); setEditing(true); }}>Rename</button></div>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </div>;
}

// Shared by the agent menu and first-run screen.
export function PairingForm({ onConnected, current }: { onConnected: () => Promise<void>; current: ProviderConfig | null }) {
  const [agents, setAgents] = useState<ProviderConfig[] | null>(null);
  const [command, setCommand] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<'' | 'command' | 'installer' | 'find' | 'select'>('');
  const [status, setStatus] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const run = async (kind: typeof busy, work: () => Promise<void>) => {
    setBusy(kind); setStatus(null);
    try { await work(); } catch (error) { setStatus({ tone: 'error', text: message(error) }); } finally { setBusy(''); }
  };
  const generate = () => run('command', async () => {
    const ticket = await window.abra!.agentTicket();
    setCommand(ticket.command); setCopied(false);
    if (!ticket.installs_cli) setStatus({ tone: 'info', text: 'Run this after installing the CLI.' });
  });
  const saveInstaller = () => run('installer', async () => {
    const file = await window.abra!.exportInstaller();
    if (file) setStatus({ tone: 'info', text: `Installer saved to ${file}. Extract it in the sandbox, then run bash abra-teleport/scripts/install-agent.sh.` });
  });
  const find = () => run('find', async () => {
    const found = await window.abra!.agentList();
    setAgents(found);
    if (!found.length) setStatus({ tone: 'info', text: 'No paired agents yet. Run the command in the sandbox, then look again.' });
  });
  const choose = (id: string) => run('select', async () => { await window.abra!.agentSelect(id); await onConnected(); });
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch (error) { setStatus({ tone: 'error', text: `Could not copy the command: ${message(error)}` }); }
  };

  return <div className="pairing">
    <p className="muted">Paste this command into your agent’s terminal.</p>
    {!command && <button className="primary" disabled={Boolean(busy)} onClick={generate}>{busy === 'command' ? 'Creating…' : 'Create command'}</button>}
    {command && <>
      <div className="command"><code>{command}</code></div>
      <div className="pairing-actions"><button className="primary" onClick={copy}>{copied ? 'Copied' : 'Copy command'}</button><button className="link" disabled={Boolean(busy)} onClick={generate}>{busy === 'command' ? 'Creating…' : 'New code'}</button><span className="meta">One use · 10 min</span></div>
    </>}
    <div className="actions"><button className="link" disabled={Boolean(busy)} onClick={find}>{busy === 'find' ? 'Looking…' : 'Find agents'}</button><button className="link" disabled={Boolean(busy)} onClick={saveInstaller}>Download CLI</button></div>
    {agents && agents.length > 0 && <ul className="rows">{agents.map(agent => {
      const active = agent.id === current?.id;
      return <li key={agent.id} className="row static">
        <span className={`dot ${active ? 'online' : 'idle'}`} /><AgentName agent={agent} onRenamed={async () => { setAgents(await window.abra!.agentList()); await onConnected(); }} />
        <span className="actions">{active ? <span className="meta">In use</span> : <button disabled={Boolean(busy)} onClick={() => choose(agent.id)}>Use</button>}</span>
      </li>;
    })}</ul>}
    {status && <p role="status" className={status.tone === 'error' ? 'notice error' : 'notice'}>{status.text}</p>}
  </div>;
}

export function statusLabel(health: ConnectionHealth | null, agent: ProviderConfig | null) {
  if (!agent) return 'Not connected';
  if (!health) return 'Checking…';
  if (health.status === 'connected') return 'Connected';
  if (health.status === 'unreachable') return 'Unreachable';
  return 'Not connected';
}

// Header pill showing the paired agent and its health. Opens a popover with details; pairing is behind one more click.
export default function AgentMenu({ agent, health, checking, refresh, onConnected }: { agent: ProviderConfig | null; health: ConnectionHealth | null; checking: boolean; refresh: () => void; onConnected: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [pairing, setPairing] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) { setPairing(false); return; }
    const onDown = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const state = !agent || !health ? 'idle' : health.status === 'connected' ? 'online' : 'off';
  return <div className="agent-menu" ref={root}>
    <button className={`agent-pill ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog">
      <span className={`dot ${state}`} /><span className="agent-pill-name">{agent?.name || 'No agent'}</span><span className="meta">{statusLabel(health, agent)}</span>
    </button>
    {open && <div className="popover" role="dialog" aria-label="Agent connection">
      {agent && <div className="agent-detail">
        <AgentName key={agent.id} agent={agent} onRenamed={onConnected} />
        <div className="agent-health">
          <span className={`dot ${state}`} />
          <span>{statusLabel(health, agent)}</span>
          <button className="link" disabled={checking} onClick={refresh}>{checking ? 'Checking…' : 'Refresh'}</button>
        </div>
        {health?.status === 'unreachable' && <p className="notice error">Could not reach the sandbox. Check that it is running and that Abra is installed there.{health.error ? ` ${health.error}` : ''}</p>}
      </div>}
      {agent && !pairing
        ? <button className="link" onClick={() => setPairing(true)}>Connect another agent</button>
        : <PairingForm current={agent} onConnected={async () => { await onConnected(); setOpen(false); }} />}
    </div>}
  </div>;
}
