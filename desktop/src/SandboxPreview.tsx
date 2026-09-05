import { useState } from 'react';

export default function SandboxPreview({ image, refresh, report }: { image?: string; refresh: () => Promise<void>; report: (message: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const input = async (payload: Record<string, unknown>) => {
    if (!window.abra || busy) return;
    setBusy(true);
    try { await window.abra.sandbox('browser-input', payload); await refresh(); }
    catch (error) { report(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <div className="sandbox-preview">
    {image ? <img src={`data:image/jpeg;base64,${image}`} alt="Sandbox browser; click the image to interact" onClick={event => {
      const img = event.currentTarget, rect = img.getBoundingClientRect();
      const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
      const x = (event.clientX - rect.left - (rect.width - img.naturalWidth * scale) / 2) / scale;
      const y = (event.clientY - rect.top - (rect.height - img.naturalHeight * scale) / 2) / scale;
      if (x >= 0 && y >= 0 && x < img.naturalWidth && y < img.naturalHeight) void input({ x, y });
    }} /> : <p>Loading the sandbox browser…</p>}
    <div className="sandbox-input"><input aria-label="Text to type into the sandbox browser" value={text} onChange={e => setText(e.target.value)} placeholder="Click a field above, then type here" /><button disabled={busy || !text} onClick={async () => { await input({ text }); setText(''); }}>Type</button>{['Enter', 'Tab', 'Backspace', 'ArrowDown', 'ArrowUp'].map(key => <button key={key} disabled={busy} onClick={() => input({ key })}>{key}</button>)}<button disabled={busy} onClick={refresh}>Refresh</button></div>
  </div>;
}
