import { useEffect, useState } from 'react';

export default function ProviderSettings({ onConnected }: { onConnected: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<ProviderConfig[]>([]);
  const [selected, setSelected] = useState<ProviderConfig | null>(null);
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => { void window.abra?.providerConfig().then(value => { setSelected(value); if (!value) setOpen(true); }); }, []);
  const refresh = async () => {
    if (!window.abra) return;
    setBusy(true);
    try { setAgents(await window.abra.agentList()); setStatus('Choose your agent below.'); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const generate = async () => {
    if (!window.abra) return;
    setBusy(true);
    try { const ticket = await window.abra.agentTicket(); setCommand(ticket.command); setStatus(ticket.installs_cli ? 'Give this command to your agent. It installs the CLI if needed, then connects. The connection expires in 10 minutes.' : 'Run this in your agent’s sandbox after installing the CLI. It expires in 10 minutes.'); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const choose = async (id: string) => {
    if (!window.abra) return;
    setBusy(true);
    try { setSelected(await window.abra.agentSelect(id)); await onConnected(); setOpen(false); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <div className="provider-settings">
    <button className="secondary" onClick={() => setOpen(!open)}>{selected ? `${selected.name} · Agent connection` : 'Connect your agent'}</button>
    {open && <div className="provider-form">
      <h2>Connect your agent’s sandbox</h2>
      <p>Give your agent a connection command. It installs the CLI if needed, then pairs the sandbox with your laptop. The sandbox needs outbound access to Abra’s network.</p>
      <button className="secondary" disabled={busy} onClick={async () => { try { const file = await window.abra?.exportInstaller(); if (file) setStatus(`Installer saved to ${file}. Give it to your agent, extract it, then run bash abra-teleport/scripts/install-agent.sh.`); } catch (error) { setStatus(String(error)); } }}>Save CLI installer</button>
      <button className="primary" disabled={busy} onClick={generate}>Create connection command</button>
      {command && <><textarea aria-label="Pairing command" readOnly value={command} rows={4} /><button className="secondary" onClick={() => navigator.clipboard.writeText(command)}>Copy command</button></>}
      <p>Only connect an agent you trust. Pairing makes it one of your Abra devices. Your laptop needs to stay online for direct handoffs.</p>
      <button className="secondary" disabled={busy} onClick={refresh}>Find connected agents</button>
      {agents.map(agent => <button className="secondary" disabled={busy} key={agent.id} onClick={() => choose(agent.id)}>{agent.name} · {agent.platform} · {agent.id.slice(0, 8)}</button>)}
      <p role="status">{status}</p>
    </div>}
  </div>;
}
