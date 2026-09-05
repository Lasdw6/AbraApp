import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AgentMenu, { PairingForm } from './ProviderSettings';
import type { BrowserSession, ConnectionHealth } from '../shared/contracts';

type Endpoint = { provider: ProviderConfig };
type Profile = { directory: string; name: string; account?: string | null; lastUsed?: boolean };
type Tab = { id: string; windowIndex: number; tabIndex: number; title: string; url: string; host: string; active: boolean };
type Cookie = { key: string; name: string; domain: string; path: string; httpOnly: boolean; secure: boolean; sameSite?: string | null; session: boolean };
type Domain = { domain: string; cookies: Cookie[]; localStorage: string[]; sessionStorage: string[]; indexedDB: string[]; warnings: string[] };
type LiveState = { available: boolean; reason?: string; scroll?: { x: number; y: number; historyLength: number }; media?: { currentTime: number; paused: boolean; playbackRate: number; volume: number; muted: boolean } | null };
type Inventory = { profile: string; domains: Domain[]; liveState?: LiveState };
type RemoteTab = { id: string; title: string; url: string; host: string };
type Incoming = { id: string; received_at: string };
type Previews = { previews: Record<string, string>; reason?: string };
// One short line of feedback, shown next to the thing the user just did.
type Notice = { text: string; error?: boolean } | null;
type Area = 'sessions' | 'tabs' | 'send' | 'remote';

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
function hostOf(url: string) { try { return new URL(url).hostname; } catch { return url; } }

async function local<T>(args: string[]): Promise<T> {
  if (!window.abra) throw new Error('Open the installed Abra Teleport desktop app.');
  return parseJSON<T>(await window.abra.local(args));
}

// Site icon fetched from the site itself, so tab hosts are not sent to a third-party icon service.
function Favicon({ host, large }: { host: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [host]);
  return <span className={`icon ${large ? 'large' : ''}`} aria-hidden>
    {failed || !host ? <span className="favicon fallback">{displayHost(host).charAt(0).toUpperCase()}</span>
      : <img className="favicon" src={`https://${host}/favicon.ico`} alt="" onError={() => setFailed(true)} />}
  </span>;
}

function NoticeLine({ notice, busy }: { notice?: Notice; busy?: boolean }) {
  if (!notice) return null;
  return <p className={`notice ${notice.error ? 'error' : ''}`} role="status" aria-live="polite">{busy && !notice.error && <span className="spinner" />}{notice.text}</p>;
}

function Browser({ endpoint, profiles, initialTabs, connected, reload }: { endpoint: Endpoint; profiles: Profile[]; initialTabs: Tab[]; connected: boolean; reload: () => Promise<Tab[]> }) {
  const [tabs, setTabs] = useState(initialTabs);
  const managed = profiles.length === 1 && profiles[0].directory === 'active';
  const [profile, setProfile] = useState(profiles.find(item => item.directory !== 'active')?.directory || profiles[0]?.directory || '');
  const [selected, setSelected] = useState<Tab | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [cookieKeys, setCookieKeys] = useState<Set<string>>(new Set());
  const [includeStorage, setIncludeStorage] = useState(true);
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteTabs, setRemoteTabs] = useState<RemoteTab[]>([]);
  const [incoming, setIncoming] = useState<Incoming[]>([]);
  const [view, setView] = useState<'list' | 'cards'>(() => localStorage.getItem('abra.tabView') === 'list' ? 'list' : 'cards');
  const chooseView = (next: 'list' | 'cards') => { setView(next); localStorage.setItem('abra.tabView', next); };
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [previewNote, setPreviewNote] = useState('');
  const [notices, setNotices] = useState<Partial<Record<Area, Notice>>>({});
  const say = (area: Area, text: string, error = false) => setNotices({ [area]: { text, error } });
  const fail = (area: Area, error: unknown) => say(area, `Failed: ${message(error)}`, true);

  const refreshSessions = async () => {
    const result = await window.abra!.sandbox('status');
    const entries = result.active.browsers || (result.active.browser ? [result.active.browser] : []);
    setSessions(entries); return entries;
  };
  const clearSelection = () => { setSelected(null); setInventory(null); setCookieKeys(new Set()); setEditing(false); };

  useEffect(() => {
    if (busy || !window.abra) return;
    let cancelled = false;
    const poll = () => { void window.abra!.sandbox('browser-incoming').then(result => { if (!cancelled) setIncoming(result.incoming); }).catch(() => {}); };
    poll(); const timer = setInterval(poll, 15000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [busy]);
  useEffect(() => setTabs(initialTabs), [initialTabs]);
  useEffect(() => {
    if (!tabs.length || view !== 'cards') { setPreviews({}); setPreviewNote(''); return; }
    let cancelled = false;
    local<Previews | null>(['browser', 'tab-previews'])
      .then(result => { if (!cancelled) { setPreviews(result?.previews || {}); setPreviewNote(result?.reason || ''); } })
      .catch(error => { if (!cancelled) setPreviewNote(message(error)); });
    return () => { cancelled = true; };
  }, [tabs, view]);
  useEffect(() => { refreshSessions().catch(error => fail('sessions', error)); }, [endpoint.provider.id]);
  useEffect(() => {
    const first = profiles.find(item => item.directory !== 'active') || profiles[0];
    if (first && (!profile || !profiles.some(item => item.directory === profile))) setProfile(first.directory);
  }, [profiles, profile]);

  const cookies = useMemo(() => inventory?.domains.flatMap(item => item.cookies) || [], [inventory]);
  const warnings = useMemo(() => [...new Set(inventory?.domains.flatMap(item => item.warnings) || [])], [inventory]);
  const githubTab = Boolean(selected && isGitHub(selected.host));
  const vercelTab = Boolean(selected && isVercel(selected.host));
  const protectedGoogleTab = Boolean(selected && isGoogleOrYouTube(selected.host));
  const isLoginCookie = (name: string) => (githubTab && isGitHubLoginCookie(name)) || (vercelTab && isVercelLoginCookie(name));
  const loginCookies = useMemo(() => cookies.filter(cookie => isLoginCookie(cookie.name)), [cookies, githubTab, vercelTab]);
  const hasPrimaryLoginCookie = !githubTab && !vercelTab ? true : cookies.some(cookie => githubTab ? cookie.name === 'user_session' : cookie.name === 'authorization');
  const loginReady = hasPrimaryLoginCookie && loginCookies.every(cookie => cookieKeys.has(cookie.key));
  const loginSite = githubTab ? 'GitHub' : vercelTab ? 'Vercel' : null;
  const visibleTabs = useMemo(() => tabs.filter(tab => `${tab.title} ${tab.host}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => Number(b.active) - Number(a.active)), [tabs, search]);

  const inspect = async (tab: Tab, chosenProfile = profile) => {
    setSelected(tab); setInventory(null); setCookieKeys(new Set()); setEditing(false); setBusy(true); setNotices({});
    try {
      const data = await local<Inventory>(['browser', 'cookie-inventory', '--profile', chosenProfile, '--url', tab.url, '--title', tab.title, '--tab-id', tab.id]);
      setInventory(data);
      setCookieKeys(new Set(isGoogleOrYouTube(tab.host) ? [] : data.domains.flatMap(item => item.cookies.map(cookie => cookie.key))));
    } catch (error) { fail('send', error); }
    finally { setBusy(false); }
  };
  const refreshTabs = async () => {
    setBusy(true); setNotices({});
    try { await reload(); } catch (error) { fail('tabs', error); } finally { setBusy(false); }
  };
  const openAbraBrowser = async () => {
    setBusy(true);
    try { await local(['browser', 'open', '--headed']); setTabs(await reload()); say('tabs', 'Sign in inside the Abra browser, then refresh.'); }
    catch (error) { fail('tabs', error); } finally { setBusy(false); }
  };
  const chooseProfile = (directory: string) => { setProfile(directory); if (selected) void inspect(selected, directory); };
  const toggleCookie = (key: string) => setCookieKeys(current => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next; });

  const send = async () => {
    if (!selected || !inventory) return;
    setBusy(true); say('send', 'Sending…');
    try {
      if (!window.abra) throw new Error('Open the installed Abra Teleport desktop app.');
      const encoded = btoa(JSON.stringify([...cookieKeys].sort()));
      await window.abra.sandbox('browser-up', {
        profile, url: selected.url, title: selected.title, 'tab-id': selected.id, cookies: encoded,
        ...(!protectedGoogleTab && cookieKeys.size === cookies.length ? { 'all-cookies': true } : {}),
        ...(!includeStorage || protectedGoogleTab ? { 'no-storage': true } : {}),
      });
      await refreshSessions(); clearSelection();
      say('sessions', `${displayHost(selected.host)} is live in the sandbox.`);
    } catch (error) { fail('send', error); }
    finally { setBusy(false); }
  };
  const bringBack = async (session: BrowserSession) => {
    setBusy(true); say('sessions', 'Bringing the tab back…');
    try {
      await window.abra?.sandbox('browser-down', { session_id: session.id });
      await refreshSessions(); clearSelection(); setTabs(await reload());
      say('sessions', 'Returned. The updated tab is open on this computer.');
    } catch (error) { fail('sessions', error); }
    finally { setBusy(false); }
  };
  const revoke = async (session: BrowserSession) => {
    if (!window.abra) return;
    if (!connected) { say('sessions', 'The sandbox is unreachable. Reconnect to revoke its session.', true); return; }
    setBusy(true); say('sessions', 'Removing the session from the sandbox…');
    try {
      const result = await window.abra.sandbox('browser-revoke', { session_id: session.id });
      await refreshSessions();
      say('sessions', `Session revoked. The tab, cookies, and site storage were removed.${result.cleanup_warning ? ` ${result.cleanup_warning}` : ''}`);
    } catch (error) { say('sessions', `Revocation failed: ${message(error)}. The session has not been confirmed removed.`, true); }
    finally { setBusy(false); }
  };
  const pull = async (action: 'browser-pull' | 'browser-accept', payload: Record<string, string>) => {
    setBusy(true); say('remote', 'Bringing the tab to this computer…');
    try {
      await window.abra!.sandbox(action, payload);
      setTabs(await reload());
      setIncoming((await window.abra!.sandbox('browser-incoming')).incoming);
      say('remote', 'The tab is open in the Abra browser on this computer.');
    } catch (error) { fail('remote', error); }
    finally { setBusy(false); }
  };
  const loadRemoteTabs = async () => {
    setRemoteOpen(true); setNotices({});
    if (!connected) { setRemoteTabs([]); say('remote', 'The sandbox is unreachable. Received tabs can still be opened.', true); return; }
    setBusy(true);
    try { setRemoteTabs((await window.abra!.sandbox('browser-tabs')).tabs); }
    catch (error) { say('remote', `Failed: ${message(error)}. The agent CLI may need an update.`, true); }
    finally { setBusy(false); }
  };

  const summary = () => {
    const parts = [protectedGoogleTab ? 'No cookies' : `${cookieKeys.size} of ${cookies.length} cookies`];
    parts.push(includeStorage && !protectedGoogleTab ? 'site storage' : 'no site storage');
    const live = inventory?.liveState;
    if (live?.available) parts.push(live.media ? `playback at ${formatDuration(live.media.currentTime)}${live.media.paused ? ', paused' : ''}` : 'scroll position');
    return parts.join(' · ');
  };
  const sendPanel = (inline: boolean) => selected && <div className={`send ${inline ? 'inline' : ''}`}>
    {!inline && <div className="send-head"><Favicon host={selected.host} /><span className="title">{selected.title || selected.host}</span><span className="meta">{displayHost(selected.host)}</span></div>}
    {!inventory && busy && <p className="notice"><span className="spinner" />Reading site data…</p>}
    {inventory && <>
      <div className="send-summary"><span>{summary()}</span>{!protectedGoogleTab && <button className="link" disabled={busy} onClick={() => setEditing(!editing)}>{editing ? 'Done' : 'Edit'}</button>}</div>
      {editing && <div className="send-edit">
        <div className="send-edit-head"><span className="muted">Cookies</span><span className="actions"><button className="link" onClick={() => selected && inspect(selected)}>Reload</button><button className="link" onClick={() => setCookieKeys(new Set(cookies.map(cookie => cookie.key)))}>All</button><button className="link" onClick={() => setCookieKeys(new Set())}>None</button></span></div>
        {cookies.length ? <ul className="cookies">{cookies.map(cookie => <li key={cookie.key}><label>
          <input type="checkbox" checked={cookieKeys.has(cookie.key)} onChange={() => toggleCookie(cookie.key)} />
          <span className="cookie-name">{cookie.name}</span><span className="meta">{cookie.domain}</span>{isLoginCookie(cookie.name) && <span className="tag">login</span>}
        </label></li>)}</ul> : <p className="muted">No cookies for this site in the chosen profile.</p>}
        <label className="check"><input type="checkbox" checked={includeStorage} onChange={event => setIncludeStorage(event.target.checked)} /><span>Include site storage <span className="meta">localStorage, sessionStorage, IndexedDB</span></span></label>
        <p className="muted">Cookie values stay hidden here and travel encrypted.</p>
      </div>}
      {inventory.liveState && !inventory.liveState.available && inventory.liveState.reason && <p className="warning">{inventory.liveState.reason}</p>}
      {protectedGoogleTab && <p className="warning">Abra does not copy cookies or storage from Google or YouTube. Replaying those login cookies can sign this computer out. The URL and playback position still move.</p>}
      {warnings.length > 0 && <p className="warning">Some selected cookies may be bound to this device and could fail in the sandbox.</p>}
      {loginSite && !hasPrimaryLoginCookie && <p className="warning">This Chrome profile is not signed in to {loginSite}. Sign in, then reload the cookies.</p>}
      {loginSite && hasPrimaryLoginCookie && !loginReady && <p className="warning">Select every {loginSite} login cookie.</p>}
      {!connected && <p className="warning">The agent is unreachable. Sending is paused until it reconnects.</p>}
      <div className="send-actions">
        <button className="primary" disabled={busy || !connected || !loginReady} onClick={send}>{loginReady ? `Send to ${endpoint.provider.name}` : `Select ${loginSite} login cookies`}</button>
        <button className="link" disabled={busy} onClick={clearSelection}>Cancel</button>
      </div>
    </>}
    <NoticeLine notice={notices.send} busy={busy} />
  </div>;

  const tabCount = tabs.length === visibleTabs.length ? `${tabs.length}` : `${visibleTabs.length} of ${tabs.length}`;
  const profileChoices = profiles.filter(item => item.directory !== 'active');
  return <main className="content">
    {(sessions.length > 0 || notices.sessions) && <section>
      <div className="section-head"><h2>In the sandbox</h2></div>
      <ul className="rows">{sessions.map(session => <li key={session.id || 'legacy'} className="row static">
        <Favicon host={hostOf(session.url)} /><span className="title">{session.title || hostOf(session.url)}</span>
        <span className="meta">{displayHost(hostOf(session.url))} · {session.cookie_count} cookies{session.include_storage ? ' · storage' : ''}</span>
        <span className="actions"><button disabled={busy} onClick={() => bringBack(session)}>Bring back</button><button className="danger" disabled={busy} onClick={() => revoke(session)}>Revoke</button></span>
      </li>)}</ul>
      <NoticeLine notice={notices.sessions} busy={busy} />
    </section>}

    <section>
      <div className="section-head">
        <h2>Chrome tabs <span className="count">{tabCount}</span></h2>
        <span className="actions">
          {managed && <button disabled={busy} onClick={openAbraBrowser}>Open Abra browser</button>}
          {!managed && profileChoices.length > 1 && <select value={profile} disabled={busy} aria-label="Chrome profile for cookies" onChange={event => chooseProfile(event.target.value)}>{profileChoices.map(item => <option key={item.directory} value={item.directory}>{item.name}</option>)}</select>}
          <button disabled={busy} onClick={refreshTabs}>Refresh</button>
          <span className="segmented" role="group" aria-label="Tab layout">
            <button className={view === 'list' ? 'on' : ''} aria-pressed={view === 'list'} onClick={() => chooseView('list')}>List</button>
            <button className={view === 'cards' ? 'on' : ''} aria-pressed={view === 'cards'} onClick={() => chooseView('cards')}>Cards</button>
          </span>
        </span>
      </div>
      {tabs.length > 6 && <input type="search" className="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search tabs" aria-label="Search tabs" />}
      <NoticeLine notice={notices.tabs} busy={busy} />
      {view === 'cards' && sendPanel(false)}
      {!visibleTabs.length ? <p className="empty">{tabs.length ? `No tabs match “${search}”.` : managed ? 'No tabs yet. Open the Abra browser, sign in, then refresh.' : 'No Chrome tabs found. Open Chrome with at least one tab, then refresh.'}</p>
        : view === 'cards' ? <div className="tab-grid">{visibleTabs.map(tab => {
          const open = selected?.id === tab.id;
          return <button key={tab.id} className={`tab-card ${open ? 'selected' : ''}`} disabled={busy && !open} aria-pressed={open} onClick={() => open ? clearSelection() : inspect(tab)}>
            <span className="preview">
              {previews[tab.id] ? <img src={previews[tab.id]} alt="" /> : <Favicon host={tab.host} large />}
              {tab.active && <span className="badge">Active</span>}
            </span>
            <span className="tab-card-text"><Favicon host={tab.host} /><span className="title">{tab.title || tab.host}</span></span>
            <span className="meta">{displayHost(tab.host)}</span>
          </button>;
        })}</div>
        : <ul className="rows">{visibleTabs.map(tab => {
          const open = selected?.id === tab.id;
          return <li key={tab.id}>
            <button className={`row ${open ? 'selected' : ''}`} disabled={busy && !open} aria-expanded={open} onClick={() => open ? clearSelection() : inspect(tab)}>
              <Favicon host={tab.host} /><span className="title">{tab.title || tab.host}</span>
              {tab.active && <span className="dot online" title="Active tab" />}<span className="meta">{displayHost(tab.host)}</span>
            </button>
            {open && sendPanel(true)}
          </li>;
        })}</ul>}
      {previewNote && <p className="muted">{previewNote}</p>}
    </section>

    <section>
      <div className="section-head">
        <h2>Sandbox tabs{incoming.length > 0 && <span className="count">{incoming.length} incoming</span>}</h2>
        <span className="actions">
          {remoteOpen && <button disabled={busy || !connected} onClick={loadRemoteTabs}>Refresh</button>}
          <button className="remote-toggle" disabled={busy} onClick={() => remoteOpen ? setRemoteOpen(false) : void loadRemoteTabs()}>{remoteOpen ? 'Hide' : 'Show'}</button>
        </span>
      </div>
      {incoming.length > 0 && <ul className="rows">{incoming.map(item => <li key={item.id} className="row static">
        <span className="title">Tab sent by your agent</span><span className="meta">{new Date(item.received_at).toLocaleString()}</span>
        <span className="actions"><button className="primary" disabled={busy} onClick={() => pull('browser-accept', { id: item.id })}>Open here</button></span>
      </li>)}</ul>}
      {remoteOpen && (remoteTabs.length > 0 ? <ul className="rows">{remoteTabs.map(tab => <li key={tab.id} className="row static">
        <Favicon host={tab.host} /><span className="title">{tab.title || tab.host}</span><span className="meta">{displayHost(tab.host)}</span>
        <span className="actions"><button disabled={busy || !connected} onClick={() => pull('browser-pull', { tab_id: tab.id })}>Pull here</button></span>
      </li>)}</ul>
        : !busy && connected && <p className="empty">No Chrome tabs open in the sandbox.</p>)}
      {remoteOpen && <p className="muted">Pulling copies the tab with its cookies and site storage. The original stays open in the sandbox. Agents can also push one with <code>abra-teleport browser send-tab &lt;tab-id&gt;</code>.</p>}
      <NoticeLine notice={notices.remote} busy={busy} />
    </section>
  </main>;
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

  return <div className="app">
    <header className="bar">
      <span className="bar-title">Abra Teleport</span>
      <AgentMenu agent={endpoint?.provider || null} health={health} checking={checking} refresh={() => void refresh()} onConnected={refresh} />
    </header>
    {error && <p className="notice error banner" role="alert">{error}<button className="link" onClick={() => setError('')}>Dismiss</button></p>}
    {!ready ? <p className="notice center"><span className="spinner" />Starting up…</p>
      : endpoint ? <Browser key={endpoint.provider.id} endpoint={endpoint} profiles={profiles} initialTabs={tabs} connected={connected} reload={refreshTabs} />
      : <main className="content narrow">
        <h2>Connect your agent</h2>
        <p className="muted">Abra moves a Chrome tab, with the cookies you choose, into the sandbox where your agent works. Bring it back when the agent is done.</p>
        <PairingForm current={null} onConnected={refresh} />
      </main>}
  </div>;
}
