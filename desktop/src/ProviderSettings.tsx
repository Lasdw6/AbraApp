import { useEffect, useRef, useState } from 'react';
import type { ConnectionHealth } from '../shared/contracts';

function message(error: unknown) { return error instanceof Error ? error.message : String(error); }

// Three-step pairing flow. Used inside the header popover and on the first-run screen.
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
    setStatus({ tone: 'info', text: ticket.installs_cli ? 'The command installs the CLI if needed, then pairs. It expires in 10 minutes.' : 'Run this after installing the CLI. It expires in 10 minutes.' });
  });
  const saveInstaller = () => run('installer', async () => {
    const file = await window.abra!.exportInstaller();
    if (file) setStatus({ tone: 'info', text: `Installer saved to ${file}. Extract it in the sandbox, then run bash abra-teleport/scripts/install-agent.sh.` });
  });
  const find = () => run('find', async () => {
    const found = await window.abra!.agentList();
    setAgents(found);
    if (!found.length) setStatus({ tone: 'info', text: 'No paired agents yet. Run the command in the sandbox, then try again.' });
  });
  const choose = (id: string) => run('select', async () => { await window.abra!.agentSelect(id); await onConnected(); });
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch (error) { setStatus({ tone: 'error', text: `Could not copy the command: ${message(error)}` }); }
  };

  return <div className="pairing">
    <ol className="steps">
      <li>
        <div className="step-text"><strong>Create a connection command</strong><span>One command installs the CLI in the sandbox and pairs it with this computer.</span></div>
        {!command && <button className="primary" disabled={Boolean(busy)} onClick={generate}>{busy === 'command' ? 'Creating…' : 'Create command'}</button>}
        {command && <div className="command-box"><code>{command}</code><div><button className="secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button><button className="link" disabled={Boolean(busy)} onClick={generate}>New command</button></div></div>}
      </li>
      <li>
        <div className="step-text"><strong>Paste it into the agent’s terminal</strong><span>The sandbox needs outbound access to Abra’s network. If it cannot download the CLI, <button className="link" disabled={Boolean(busy)} onClick={saveInstaller}>save the installer</button> and hand it over instead.</span></div>
      </li>
      <li>
        <div className="step-text"><strong>Pick the paired agent</strong><span>Agents show up here once the command finishes.</span></div>
        <button className="secondary" disabled={Boolean(busy)} onClick={find}>{busy === 'find' ? 'Looking…' : agents ? 'Look again' : 'Find agents'}</button>
        {agents && agents.length > 0 && <div className="agent-list">{agents.map(agent => {
          const active = agent.id === current?.id;
          return <button key={agent.id} className={`agent-row ${active ? 'selected' : ''}`} disabled={Boolean(busy) || active} onClick={() => choose(agent.id)}>
            <span className={`dot ${active ? 'online' : 'idle'}`} /><span className="agent-row-name">{agent.name}</span><span className="agent-row-meta">{agent.platform} · {agent.id.slice(0, 8)}</span><span className="agent-row-action">{active ? 'In use' : 'Use'}</span>
          </button>;
        })}</div>}
      </li>
    </ol>
    {status && <p role="status" className={status.tone === 'error' ? 'form-status error' : 'form-status'}>{status.text}</p>}
    <p className="hint">Only connect an agent you trust. Pairing makes it one of your Abra devices. This computer must stay online during handoffs.</p>
  </div>;
}

export function statusLabel(health: ConnectionHealth | null, agent: ProviderConfig | null) {
  if (!agent) return 'Not connected';
  if (!health) return 'Checking…';
  if (health.status === 'connected') return 'Connected';
  if (health.status === 'unreachable') return 'Unreachable';
  return 'Not connected';
}

// Header pill showing the paired agent and its health. Opens a popover with details and the pairing flow.
export default function ProviderSettings({ agent, health, checking, refresh, onConnected }: { agent: ProviderConfig | null; health: ConnectionHealth | null; checking: boolean; refresh: () => void; onConnected: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const state = !agent ? 'idle' : !health ? 'idle' : health.status === 'connected' ? 'online' : 'off';
  return <div className="agent-menu" ref={root}>
    <button className={`agent-pill ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog">
      <span className={`dot ${state}`} /><span className="agent-pill-name">{agent?.name || 'No agent'}</span><span className="agent-pill-status">{statusLabel(health, agent)}</span><span className="chevron" aria-hidden>⌄</span>
    </button>
    {open && <div className="popover" role="dialog" aria-label="Agent connection">
      {agent && <div className="agent-detail">
        <div><strong>{agent.name}</strong><span>{agent.platform} · {agent.id.slice(0, 8)}</span></div>
        <div className="agent-detail-health">
          <span className={`dot ${state}`} />
          <span>{statusLabel(health, agent)}{health?.last_seen ? ` · last reached ${new Date(health.last_seen).toLocaleTimeString()}` : ''}</span>
          <button className="link" disabled={checking} onClick={refresh}>{checking ? 'Checking…' : 'Check now'}</button>
        </div>
        {health?.status === 'unreachable' && <div className="warning">Could not reach the sandbox. Check that it is running and that Abra is installed there.{health.error ? ` ${health.error}` : ''}</div>}
      </div>}
      <h3>{agent ? 'Connect a different agent' : 'Connect your agent'}</h3>
      <PairingForm current={agent} onConnected={async () => { await onConnected(); setOpen(false); }} />
    </div>}
  </div>;
}
