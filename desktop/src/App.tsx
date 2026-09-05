import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import ProviderSettings, { PairingForm } from './ProviderSettings';
import type { BrowserSession, ConnectionHealth } from '../shared/contracts';

type Endpoint = { provider: ProviderConfig };
type Profile = { directory: string; name: string; account?: string | null; lastUsed?: boolean };
type Tab = { id: string; windowIndex: number; tabIndex: number; title: string; url: string; host: string; active: boolean };
type Cookie = { key: string; name: string; domain: string; path: string; httpOnly: boolean; secure: boolean; sameSite?: string | null; session: boolean };
type Domain = { domain: string; cookies: Cookie[]; localStorage: string[]; sessionStorage: string[]; indexedDB: string[]; warnings: string[] };
type LiveState = { available: boolean; reason?: string; scroll?: { x: number; y: number; historyLength: number }; media?: { currentTime: number; paused: boolean; playbackRate: number; volume: number; muted: boolean } | null };
type Inventory = { profile: string; domains: Domain[]; liveState?: LiveState };


function parseJSON<T>(raw: string): T { return JSON.parse(raw) as T; }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function formatDuration(value: number) { const seconds = Math.max(0, Math.floor(value)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
function isGitHub(host: string) { return host === 'github.com' || host.endsWith('.github.com'); }
function isGitHubLoginCookie(name: string) { return name === 'user_session' || name === '__Host-user_session_same_site'; }
function isVercel(host: string) { return host === 'vercel.com' || host.endsWith('.vercel.com'); }
function isVercelLoginCookie(name: string) { return ['authorization', 'isLoggedIn', 'lastUsedAuth', 'scope', 'teamsCache', 'userCache', 'userDisplayCache'].includes(name); }
function isYouTube(host: string) { return host === 'youtube.com' || host.endsWith('.youtube.com'); }
function isGoogleOrYouTube(host: string) { return isYouTube(host) || host === 'google.com' || host.endsWith('.google.com') || /(^|\.)google\.[a-z]{2,}(?:\.[a-z]{2})?$/.test(host); }
function displayHost(host: string) { return host.replace(/^www\./, ''); }
// Stable accent hue per site so the grid is scannable without favicons.
const HUES = [216, 262, 152, 28, 340, 190, 48];
function siteHue(host: string) { let hash = 0; for (const char of displayHost(host)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; return HUES[hash % HUES.length]; }

async function local<T>(args: string[]): Promise<T> {
  if (!window.abra) throw new Error('Open the installed Abra Teleport desktop app.');
  return parseJSON<T>(await window.abra.local(args));
}
function Check({ checked }: { checked: boolean }) {
  return <span className={`check ${checked ? 'checked' : ''}`} aria-hidden>{checked ? '✓' : ''}</span>;
}
function SiteMark({ host }: { host: string }) {
  return <span className="site-mark" style={{ '--h': siteHue(host) } as CSSProperties}>{displayHost(host).slice(0, 2).toUpperCase()}</span>;
}

function Header({ agent, health, checking, refresh, onConnected }: { agent: ProviderConfig | null; health: ConnectionHealth | null; checking: boolean; refresh: () => void; onConnected: () => Promise<void> }) {
  return <header>
    <div className="brand"><span className="brand-mark" aria-hidden>⇄</span><div><h1>Abra Teleport</h1><p>Move a signed-in browser tab to your agent’s sandbox and bring it back.</p></div></div>
    <ProviderSettings agent={agent} health={health} checking={checking} refresh={refresh} onConnected={onConnected} />
  </header>;
}

function Onboarding({ onConnected }: { onConnected: () => Promise<void> }) {
  return <section className="onboarding">
    <div className="onboarding-card">
      <span className="eyebrow">GET STARTED</span>
      <h2>Connect your agent’s sandbox</h2>
      <p className="lede">Abra moves a Chrome tab, with the cookies you choose, into the sandbox where your agent works. When the agent is done you bring the tab back here.</p>
      <PairingForm current={null} onConnected={onConnected} />
    </div>
  </section>;
}

function Browser({ endpoint, profiles, initialTabs, connected, reload }: { endpoint: Endpoint; profiles: Profile[]; initialTabs: Tab[]; connected: boolean; reload: () => Promise<Tab[]> }) {
  const [tabs, setTabs] = useState(initialTabs);
  const managed = profiles.length === 1 && profiles[0].directory === 'active';
  const [profile, setProfile] = useState(profiles.find(item => item.directory !== 'active')?.directory || profiles[0]?.directory || '');
  const [selected, setSelected] = useState<Tab | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [cookieKeys, setCookieKeys] = useState<Set<string>>(new Set());
  const [includeStorage, setIncludeStorage] = useState(true);
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState<'pick' | 'cloud' | 'remote'>('pick');
  const [sentCookieCount, setSentCookieCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Pick a tab to get started.');
  const [activity, setActivity] = useState<string[]>([]);
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [remoteTabs, setRemoteTabs] = useState<Array<{ id: string; title: string; url: string; host: string }>>([]);
  const [incoming, setIncoming] = useState<Array<{ id: string; received_at: string }>>([]);
  const showSession = (session: BrowserSession) => {
    const url = new URL(session.url);
    setSelected({ id: 'restored', windowIndex: 0, tabIndex: 0, title: session.title, url: session.url, host: url.hostname, active: false });
    setSentCookieCount(session.cookie_count); setIncludeStorage(session.include_storage); setSessionId(session.id); setStage('cloud');
    setStatus('Viewing the selected session.');
  };
  const refreshSessions = async () => {
    const result = await window.abra!.sandbox('status');
    const entries = result.active.browsers || (result.active.browser ? [result.active.browser] : []);
    setSessions(entries); return entries;
  };
  const picker = () => { setStage('pick'); setSelected(null); setInventory(null); setCookieKeys(new Set()); };
  useEffect(() => {
    if (busy || !window.abra) return;
    let cancelled = false;
    const poll = () => { void window.abra!.sandbox('browser-incoming').then(result => { if (!cancelled) setIncoming(result.incoming); }).catch(() => {}); };
    poll(); const timer = setInterval(poll, 15000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [busy]);


  useEffect(() => setTabs(initialTabs), [initialTabs]);
  useEffect(() => {
    void refreshSessions().then(entries => {
      if (entries.length) { showSession(entries.at(-1)!); setStatus('Choose a session, send another tab, or pull a tab from the sandbox.'); }
    }).catch(error => setStatus(message(error)));
  }, [endpoint.provider.id]);
  useEffect(() => {
    const first = profiles.find(item => item.directory !== 'active') || profiles[0];
    if (first && (!profile || !profiles.some(item => item.directory === profile))) setProfile(first.directory);
  }, [profiles, profile]);

  const log = (text: string) => { setStatus(text); setActivity(current => [...current, text]); };
  const cookies = useMemo(() => inventory?.domains.flatMap(item => item.cookies) || [], [inventory]);
  const warnings = useMemo(() => [...new Set(inventory?.domains.flatMap(item => item.warnings) || [])], [inventory]);
  const githubTab = Boolean(selected && isGitHub(selected.host));
  const vercelTab = Boolean(selected && isVercel(selected.host));
  const protectedGoogleTab = Boolean(selected && isGoogleOrYouTube(selected.host));
  const loginCookies = useMemo(() => cookies.filter(cookie => githubTab ? isGitHubLoginCookie(cookie.name) : vercelTab ? isVercelLoginCookie(cookie.name) : false), [cookies, githubTab, vercelTab]);
  const hasPrimaryLoginCookie = !githubTab && !vercelTab
    ? true
    : cookies.some(cookie => githubTab ? cookie.name === 'user_session' : cookie.name === 'authorization');
  const loginReady = hasPrimaryLoginCookie && loginCookies.every(cookie => cookieKeys.has(cookie.key));
  const loginSite = githubTab ? 'GitHub' : vercelTab ? 'Vercel' : null;
  const visibleTabs = useMemo(() => tabs.filter(tab => `${tab.title} ${tab.host}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => Number(b.active) - Number(a.active)), [tabs, search]);

  const inspect = async (tab: Tab, chosenProfile = profile) => {
    setSelected(tab); setInventory(null); setCookieKeys(new Set()); setBusy(true); setActivity([]);
    log(`Reading cookies for ${displayHost(tab.host)}…`);
    try {
      const data = await local<Inventory>(['browser', 'cookie-inventory', '--profile', chosenProfile, '--url', tab.url, '--title', tab.title, '--tab-id', tab.id]);
      setInventory(data);
      setCookieKeys(new Set(isGoogleOrYouTube(tab.host) ? [] : data.domains.flatMap(item => item.cookies.map(cookie => cookie.key))));
      log('Choose the cookies to send.');
    } catch (error) { log(`Failed: ${message(error)}`); }
    finally { setBusy(false); }
  };

  const refreshTabs = async () => {
    setBusy(true);
    try { const next = await reload(); log(next.length ? `Found ${next.length} open tab${next.length === 1 ? '' : 's'}.` : 'No Chrome tabs found.'); }
    catch (error) { log(`Failed: ${message(error)}`); }
    finally { setBusy(false); }
  };
  const chooseProfile = (directory: string) => { setProfile(directory); if (selected) void inspect(selected, directory); };
  const toggleCookie = (key: string) => setCookieKeys(current => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next; });

  const send = async () => {
    if (!selected || !inventory) return;
    setBusy(true); setActivity([]);
    try {
      log('Packing the tab and selected cookies…');
      if (!window.abra) throw new Error('Open the installed Abra Teleport desktop app.');
      const encoded = btoa(JSON.stringify([...cookieKeys].sort()));
      const prepared = await window.abra.sandbox('browser-up', {
        profile, url: selected.url, title: selected.title, 'tab-id': selected.id, cookies: encoded,
        ...(!protectedGoogleTab && cookieKeys.size === cookies.length ? { 'all-cookies': true } : {}),
        ...(!includeStorage || protectedGoogleTab ? { 'no-storage': true } : {}),
      });
      await refreshSessions(); showSession(prepared.session);
      log('Live in the sandbox.');
    } catch (error) { log(`Failed: ${message(error)}`); }
    finally { setBusy(false); }
  };

  const bringBack = async () => {
    setBusy(true);
    try {
      log('Bringing the live browser back to this computer…');
      await window.abra?.sandbox('browser-down', { session_id: sessionId });
      await refreshSessions(); picker(); setTabs(await reload());
      log('Returned. The updated tab is open on this computer.');
    } catch (error) { log(`Failed: ${message(error)}`); }
    finally { setBusy(false); }
  };

  const revoke = async () => {
    if (!window.abra) return;
    if (!connected) { log('The sandbox is unreachable. Reconnect to revoke its session.'); return; }
    setBusy(true);
    try {
      log('Removing the session from the sandbox…');
      const result = await window.abra.sandbox('browser-revoke', { session_id: sessionId });
      await refreshSessions();
      setStage('pick'); setSelected(null); setInventory(null); setCookieKeys(new Set());
      setSentCookieCount(0);
      log(`Session revoked. The transferred tab, cookies, and site storage were removed.${result.cleanup_warning ? ` ${result.cleanup_warning}` : ''}`);
    } catch (error) { log(`Revocation failed: ${message(error)}. The session has not been confirmed removed.`); }
    finally { setBusy(false); }
  };

  const pull = async (action: 'browser-pull' | 'browser-accept', payload: Record<string, string>) => {
    setBusy(true);
    try {
      log('Bringing the tab to this computer…');
      await window.abra!.sandbox(action, payload);
      setTabs(await reload());
      setIncoming((await window.abra!.sandbox('browser-incoming')).incoming);
      log('The tab is open in the Abra browser on this computer.');
    } catch (error) { log(`Failed: ${message(error)}`); }
    finally { setBusy(false); }
  };
  const loadRemoteTabs = async () => {
    setStage('remote');
    if (!connected) { setRemoteTabs([]); log('The sandbox is unreachable. You can still open received tabs.'); return; }
    setBusy(true);
    try { setRemoteTabs((await window.abra!.sandbox('browser-tabs')).tabs); log('Choose a sandbox tab to pull.'); }
    catch (error) { log(`Failed: ${message(error)}. The agent CLI may need an update.`); }
    finally { setBusy(false); }
  };
  const navigation = <nav className="browser-navigation" aria-label="Browser sessions">
    <button className={stage === 'pick' ? 'active' : ''} disabled={busy} onClick={picker}>Send another tab</button>
    <button className={stage === 'remote' ? 'active' : ''} disabled={busy} onClick={loadRemoteTabs}>Sandbox tabs{incoming.length ? ` · ${incoming.length} incoming` : ''}</button>
    {sessions.map((session, index) => <button key={session.id || 'legacy'} className={stage === 'cloud' && session.id === sessionId ? 'active' : ''} disabled={busy} onClick={() => showSession(session)} title={session.url}>Session {index + 1} · {new URL(session.url).hostname}</button>)}
  </nav>;
  if (stage === 'remote') return <div className="browser-workspace">{navigation}<section className="remote-browser">
    <main className="tab-panel">
      <div className="section-title"><div><h2>Tabs on your agent’s computer</h2><p>Pull a tab with its cookies and site storage. The original stays open in the sandbox.</p></div><button className="secondary" disabled={busy || !connected} onClick={loadRemoteTabs}>Refresh</button></div>
      {incoming.length > 0 && <div className="incoming-tabs"><h3>Sent by your agent</h3>{incoming.map(item => <div key={item.id}><span>Incoming tab · {new Date(item.received_at).toLocaleString()}</span><button className="primary" disabled={busy} onClick={() => pull('browser-accept', { id: item.id })}>Open on this computer</button></div>)}</div>}
      <div className="tab-grid">{remoteTabs.map(tab => <button className="tab-card" key={tab.id} disabled={busy || !connected} onClick={() => pull('browser-pull', { tab_id: tab.id })}><SiteMark host={tab.host} /><strong>{tab.title || tab.host}</strong><span>{tab.host}</span><small>Pull to this computer</small></button>)}</div>
      {!remoteTabs.length && !busy && <p className="hint">{connected ? 'No compatible Chrome tabs found. Open a site in the sandbox browser, then refresh.' : 'The sandbox is unreachable. Previously received tabs remain available above.'}</p>}
      <p className="hint">Agents can run <code>abra-teleport browser available-tabs</code>, then <code>abra-teleport browser send-tab &lt;tab-id&gt;</code>. Sent tabs appear here for you to open.</p>
    </main><Activity status={status} lines={activity} busy={busy} />
  </section></div>;

  if (stage === 'cloud') return <div className="browser-workspace">{navigation}<section className="browser-cloud">
    <main className="cloud-card">
      <div className="cloud-heading">
        <span className={`live-badge ${connected ? '' : 'offline'}`}><span className={`dot ${connected ? 'online pulse' : 'off'}`} />{connected ? 'SESSION IN YOUR SANDBOX' : 'SANDBOX UNREACHABLE'}</span>
        <div className="cloud-title">{selected && <SiteMark host={selected.host} />}<div><h2>{selected?.title || selected?.host}</h2><p className="session-url">{selected?.url}</p></div></div>
      </div>
      <dl className="facts">
        <div><dt>Cookies sent</dt><dd>{sentCookieCount}</dd></div>
        <div><dt>Site storage</dt><dd>{includeStorage && !protectedGoogleTab ? 'Included' : 'Not sent'}</dd></div>
        <div><dt>Agent</dt><dd className="truncate">{endpoint.provider.name}</dd></div>
        <div><dt>Connection</dt><dd className={connected ? 'ok' : 'warn'}>{connected ? 'Connected' : 'Unreachable'}</dd></div>
      </dl>
      <p className="lede">Your agent can now use this tab in its own browser. This computer stays signed in. When the agent is done, bring the tab back to pick up where it left off.</p>
      {selected && isGoogleOrYouTube(selected.host) && <div className="warning">Google and YouTube account login is intentionally not moved. Replaying those login cookies can invalidate the session on this computer.</div>}
      <div className="cloud-actions">
        <button className="primary wide" disabled={busy} onClick={bringBack}>{busy ? 'Working…' : 'Bring back to this computer'}</button>
        <button className="secondary danger wide" disabled={busy} onClick={revoke}>Revoke session</button>
      </div>
      <p className="hint">Revoking removes the transferred tab, cookies, and site storage from the sandbox. To invalidate the login token everywhere, use the website’s session settings.</p>
    </main>
    <Activity status={status} lines={activity} busy={busy} />
  </section></div>;

  const tabCount = tabs.length === visibleTabs.length ? `${tabs.length} open` : `${visibleTabs.length} of ${tabs.length}`;
  return <div className="browser-workspace">{navigation}<section className="browser-pick">
    <main className="tab-panel">
      <div className="section-title">
        <div><h2>Choose a Chrome tab <span className="count">{tabCount}</span></h2><p>{managed ? 'Sign in inside the Abra browser, then refresh. Your regular browser stays separate.' : 'Tabs open in Chrome right now. The active one is listed first.'}</p></div>
        <div className="section-actions">
          {managed && <button className="secondary" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await local(['browser', 'open', '--headed']); setTabs(await reload()); log('Open your site and sign in, then refresh tabs.'); }
            catch (error) { log(message(error)); } finally { setBusy(false); }
          }}>Open Abra browser</button>}
          <button className="secondary" disabled={busy} onClick={refreshTabs}>Refresh</button>
        </div>
      </div>
      <div className="toolbar">
        <label className="search"><span aria-hidden>⌕</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search tabs" aria-label="Search tabs" /></label>
        <div className="profile-picker"><span className="muted">Cookies from</span><div className="profile-list">{profiles.filter(item => managed || item.directory !== 'active').map(item => <button key={item.directory} className={profile === item.directory ? 'selected' : ''} title={item.account || undefined} onClick={() => chooseProfile(item.directory)}>{item.name}{item.lastUsed ? <small>recent</small> : null}</button>)}</div></div>
      </div>
      {visibleTabs.length > 0 ? <div className="tab-grid">{visibleTabs.map(tab => <button key={tab.id} className={`tab-card ${selected?.id === tab.id ? 'selected' : ''}`} disabled={busy} onClick={() => inspect(tab)} aria-pressed={selected?.id === tab.id}>
        <div className="tab-card-top"><SiteMark host={tab.host} />{tab.active && <span className="open-label">ACTIVE</span>}</div>
        <strong>{tab.title || tab.host}</strong><span>{displayHost(tab.host)}</span><small>Window {tab.windowIndex} · Tab {tab.tabIndex}</small>
      </button>)}</div>
        : <div className="empty">{tabs.length ? <><strong>No tabs match “{search}”.</strong><span>Try a different search.</span></> : <><strong>No Chrome tabs found.</strong><span>Open Chrome with at least one tab, then refresh.</span></>}</div>}
    </main>
    <aside className="cookie-panel">
      <div className="panel-heading"><h2>Send with this tab</h2>{selected && !busy && <button className="link" onClick={() => { setSelected(null); setInventory(null); setCookieKeys(new Set()); setStatus('Pick a tab to get started.'); }}>Clear</button>}</div>
      {!selected && <div className="empty"><span className="empty-mark" aria-hidden>⇄</span><strong>Nothing selected yet.</strong><span>Pick a tab on the left to see which cookies would travel with it.</span></div>}
      {selected && <div className="selected-tab"><SiteMark host={selected.host} /><div><strong>{selected.title || selected.host}</strong><span>{selected.url}</span></div></div>}
      {selected && !inventory && <div className="loading"><span className="spinner" />Reading site data…</div>}
      {inventory && <>
        {inventory.liveState?.available ? <div className="route-live"><span className="dot online" /><div><strong>Live tab state travels too</strong><small>{inventory.liveState.media ? `Playback at ${formatDuration(inventory.liveState.media.currentTime)} · ${inventory.liveState.media.paused ? 'paused' : 'playing'} · ${inventory.liveState.media.playbackRate}×` : 'Scroll position moves with this tab.'}</small></div></div> : inventory.liveState?.reason && <div className="warning">{inventory.liveState.reason}</div>}
        <div className="cookie-heading"><div><h3>Cookies</h3><span>{cookieKeys.size} of {cookies.length} selected</span></div><div><button className="link" onClick={() => selected && inspect(selected)}>Refresh</button><button className="link" disabled={protectedGoogleTab} onClick={() => setCookieKeys(new Set(cookies.map(cookie => cookie.key)))}>All</button><button className="link" onClick={() => setCookieKeys(new Set())}>None</button></div></div>
        <div className="cookie-list">{cookies.length ? cookies.map(cookie => {
          return <button className="cookie" key={cookie.key} disabled={protectedGoogleTab} onClick={() => toggleCookie(cookie.key)} aria-pressed={cookieKeys.has(cookie.key)}><Check checked={!protectedGoogleTab && cookieKeys.has(cookie.key)} /><div><strong>{cookie.name}</strong><span>{cookie.domain}</span><div className="badges">{protectedGoogleTab && <i>Not transferred</i>}{((githubTab && isGitHubLoginCookie(cookie.name)) || (vercelTab && isVercelLoginCookie(cookie.name))) && <i className="login">Login session</i>}{cookie.httpOnly && <i>HttpOnly</i>}{cookie.secure && <i>Secure</i>}{cookie.sameSite && <i>{cookie.sameSite}</i>}</div></div></button>;
        }) : <p className="muted">No cookies for this site in the chosen profile.</p>}</div>
        <p className="hint">Cookie values stay hidden here and travel encrypted.</p>
        <label className="storage"><input type="checkbox" disabled={protectedGoogleTab} checked={includeStorage && !protectedGoogleTab} onChange={event => setIncludeStorage(event.target.checked)} /><span><strong>Include site storage</strong><small>{protectedGoogleTab ? 'Not transferred for Google or YouTube' : 'localStorage, sessionStorage, and IndexedDB'}</small></span></label>
        {protectedGoogleTab && <div className="warning">For safety, Abra does not copy cookies or storage from Google or YouTube. The tab URL and playback position can still move.</div>}
        {warnings.length > 0 && <div className="warning">Some selected cookies may be bound to this device and could fail in the sandbox.</div>}
        {loginSite && !hasPrimaryLoginCookie && <div className="warning">This Chrome profile is not signed in to {loginSite}. Sign in, then refresh the cookies here.</div>}
        {loginSite && hasPrimaryLoginCookie && !loginReady && <div className="warning">Select every {loginSite} login-session cookie.</div>}
        {!connected && <div className="warning">The agent is unreachable. Sending is paused until it reconnects.</div>}
        <button className="primary wide" disabled={busy || !connected || !loginReady} onClick={send}>{busy ? 'Working…' : loginReady ? `Send to ${endpoint.provider.name}` : `Select ${loginSite} login cookies`}</button>
      </>}
    </aside>
    <Activity status={status} lines={activity} busy={busy} />
  </section></div>;
}

function Activity({ status, lines, busy }: { status: string; lines: string[]; busy: boolean }) {
  const failed = /^(Failed|Revocation failed)/.test(status);
  const previous = lines.at(-2);
  return <footer className={`activity ${failed ? 'failed' : ''}`} role="status" aria-live="polite">
    <span className="activity-state">{busy ? <span className="spinner small" /> : <span className={`dot ${failed ? 'off' : 'online'}`} />}</span>
    <strong>{status}</strong>
    {previous && <span className="activity-previous">{previous}</span>}
  </footer>;
}

export default function App() {
  const [health, setHealth] = useState<ConnectionHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const [endpoint, setEndpoint] = useState<Endpoint | null>(null);
  const [ready, setReady] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [error, setError] = useState('');
  const inFlight = useRef<Promise<void> | null>(null);
  const connected = health?.status === 'connected' && health.agent_id === endpoint?.provider.id;
  const refreshTabs = async () => { const value = await local<Tab[]>(['browser', 'tabs']); setTabs(value); return value; };
  const refresh = useCallback(async () => {
    while (inFlight.current) await inFlight.current;
    const operation = (async () => {
      setChecking(true);
      try {
        if (!window.abra) throw new Error('Open the installed desktop app.');
        const provider = await window.abra.providerConfig();
        setEndpoint(provider ? { provider } : null);
        setHealth(previous => previous?.agent_id === (provider?.id || null) ? previous : null);
        const result = await window.abra.connectionHealth();
        setHealth(result);
      } catch (caught) {
        setHealth(previous => ({ agent_id: previous?.agent_id || null, status: 'unreachable', last_seen: previous?.last_seen || null, checked_at: new Date().toISOString(), error: message(caught) }));
      } finally { setChecking(false); setReady(true); }
    })();
    inFlight.current = operation;
    try { await operation; } finally { if (inFlight.current === operation) inFlight.current = null; }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (!inFlight.current) void refresh(); }, 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    void Promise.all([local<Profile[]>(['browser', 'profiles']), local<Tab[]>(['browser', 'tabs'])])
      .then(([p, t]) => { setProfiles(p); setTabs(t); }).catch(error => setError(message(error)));
  }, []);

  return <div className="app-shell">
    <Header agent={endpoint?.provider || null} health={health} checking={checking} refresh={() => void refresh()} onConnected={refresh} />
    {error && <div className="global-error" role="alert">{error}<button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    {!ready ? <div className="boot"><span className="spinner" />Starting up…</div>
      : endpoint ? <Browser key={endpoint.provider.id} endpoint={endpoint} profiles={profiles} initialTabs={tabs} connected={connected} reload={refreshTabs} />
      : <Onboarding onConnected={refresh} />}
  </div>;
}
