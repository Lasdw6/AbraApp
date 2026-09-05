import { useCallback, useEffect, useMemo, useState } from 'react';
import ProviderSettings from './ProviderSettings';
import SandboxPreview from './SandboxPreview';

type Endpoint = { provider: ProviderConfig };
type Profile = { directory: string; name: string; account?: string | null; lastUsed?: boolean };
type Tab = { id: string; windowIndex: number; tabIndex: number; title: string; url: string; host: string; active: boolean };
type Cookie = { key: string; name: string; domain: string; path: string; httpOnly: boolean; secure: boolean; sameSite?: string | null; session: boolean };
type Domain = { domain: string; cookies: Cookie[]; localStorage: string[]; sessionStorage: string[]; indexedDB: string[]; warnings: string[] };
type LiveState = { available: boolean; reason?: string; scroll?: { x: number; y: number; historyLength: number }; media?: { currentTime: number; paused: boolean; playbackRate: number; volume: number; muted: boolean } | null };
type Inventory = { profile: string; domains: Domain[]; liveState?: LiveState };
type Session = { session_id: string; cwd: string; updated_at: string; bytes: number; last_prompt?: string | null; workspace_exists?: boolean; active_writer?: boolean | null };
type SessionMessage = { role: 'user' | 'assistant'; text: string };
type SessionDetails = Session & { user_turns: number; assistant_messages: number; messages: SessionMessage[] };
type AppRecipe = { argv: string[]; cwd: string; ports: number[] };
type AppInspection = { workspace: string; recipes: AppRecipe[]; selected: AppRecipe | null };
type LocalApp = { active: boolean; url: string; port: number; workspace: string; command: string[]; output: string };
type Frame = { title: string; url: string; image: string; githubSignedIn?: boolean | null; vercelSignedIn?: boolean | null };


function parseJSON<T>(raw: string): T { return JSON.parse(raw) as T; }
function parseLine<T>(raw: string, match: (value: unknown) => boolean): T {
  for (const line of raw.split('\n')) {
    try { const value = JSON.parse(line); if (match(value)) return value as T; } catch { /* next line */ }
  }
  throw new Error('The cloud returned an unreadable response.');
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function folder(path: string) { return path.split('/').filter(Boolean).at(-1) || path; }
function shortID(id: string) { return `…${id.slice(-8)}`; }
function formatBytes(value: number) { return value < 1_000_000 ? `${Math.round(value / 1000)} KB` : `${(value / 1_000_000).toFixed(1)} MB`; }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }
function formatDuration(value: number) { const seconds = Math.max(0, Math.floor(value)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
function isGitHub(host: string) { return host === 'github.com' || host.endsWith('.github.com'); }
function isGitHubLoginCookie(name: string) { return name === 'user_session' || name === '__Host-user_session_same_site'; }
function isVercel(host: string) { return host === 'vercel.com' || host.endsWith('.vercel.com'); }
function isVercelLoginCookie(name: string) { return ['authorization', 'isLoggedIn', 'lastUsedAuth', 'scope', 'teamsCache', 'userCache', 'userDisplayCache'].includes(name); }
function isYouTube(host: string) { return host === 'youtube.com' || host.endsWith('.youtube.com'); }
function isGoogleOrYouTube(host: string) { return isYouTube(host) || host === 'google.com' || host.endsWith('.google.com') || /(^|\.)google\.[a-z]{2,}(?:\.[a-z]{2})?$/.test(host); }

async function local<T>(args: string[]): Promise<T> {
  if (!window.abra) throw new Error('Open the installed Abra Teleport desktop app.');
  return parseJSON<T>(await window.abra.local(args));
}
function Check({ checked }: { checked: boolean }) {
  return <span className={`check ${checked ? 'checked' : ''}`}>{checked ? '✓' : ''}</span>;
}

function Header({ mode, setMode, connected, refresh }: { mode: string; setMode: (mode: 'browser' | 'codex') => void; connected: boolean; refresh: () => void }) {
  return <>
    <header>
      <div><h1>Abra Teleport</h1><p>Move a live session to the cloud and bring it back.</p></div>
      <div className="connection"><span className={connected ? 'dot online' : 'dot'} />{connected ? 'Cloud connected' : 'Cloud offline'}<button className="icon-button" onClick={refresh} title="Refresh">↻</button></div>
    </header>
    <nav><button className={mode === 'browser' ? 'active' : ''} onClick={() => setMode('browser')}>Browser</button><button className={mode === 'codex' ? 'active' : ''} onClick={() => setMode('codex')}>Codex</button></nav>
  </>;
}

function Browser({ endpoint, profiles, initialTabs, connected, reload }: { endpoint: Endpoint | null; profiles: Profile[]; initialTabs: Tab[]; connected: boolean; reload: () => Promise<Tab[]> }) {
  const [tabs, setTabs] = useState(initialTabs);
  const managed = profiles.length === 1 && profiles[0].directory === 'active';
  const [profile, setProfile] = useState(profiles.find(item => item.directory !== 'active')?.directory || profiles[0]?.directory || '');
  const [selected, setSelected] = useState<Tab | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [cookieKeys, setCookieKeys] = useState<Set<string>>(new Set());
  const [includeStorage, setIncludeStorage] = useState(true);
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState<'pick' | 'cloud'>('pick');
  const [frame, setFrame] = useState<Frame | null>(null);
  const [sentCookieCount, setSentCookieCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Pick a tab.');
  const [activity, setActivity] = useState<string[]>([]);

  useEffect(() => setTabs(initialTabs), [initialTabs]);
  useEffect(() => {
    if (!endpoint?.provider) return;
    void window.abra?.sandbox('status').then(result => {
      const active = result.active?.browser;
      if (!active) return;
      const url = new URL(active.url);
      setSelected({ id: 'restored', windowIndex: 0, tabIndex: 0, title: active.title, url: active.url, host: url.hostname, active: false });
      setSentCookieCount(active.cookie_count); setIncludeStorage(active.include_storage); setStage('cloud');
    }).catch(error => setStatus(message(error)));
  }, [endpoint?.provider?.id]);
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
    log(`Reading cookies for ${tab.host}…`);
    try {
      const data = await local<Inventory>(['browser', 'cookie-inventory', '--profile', chosenProfile, '--url', tab.url, '--title', tab.title, '--tab-id', tab.id]);
      setInventory(data);
      setCookieKeys(new Set(isGoogleOrYouTube(tab.host) ? [] : data.domains.flatMap(item => item.cookies.map(cookie => cookie.key))));
      log('Choose the cookies to send.');
    } catch (error) { log(`Failed: ${message(error)}`); }
    finally { setBusy(false); }
  };

  const chooseProfile = (directory: string) => { setProfile(directory); if (selected) void inspect(selected, directory); };
  const toggleCookie = (key: string) => setCookieKeys(current => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next; });

  const refreshFrame = useCallback(async () => {
    if (stage !== 'cloud' || !window.abra) return;
    try {
      const raw = JSON.stringify(await window.abra.sandbox('browser-frame'));
      const next = parseLine<Frame>(raw, value => Boolean(value && typeof value === 'object' && 'image' in value));
      setFrame(next);
      if (selected && isGitHub(selected.host) && next.githubSignedIn === false) {
        setStatus('GitHub opened in the cloud, but it is signed out.');
      } else if (selected && isVercel(selected.host) && next.vercelSignedIn === false) {
        setStatus('Vercel opened in the cloud, but it is signed out.');
      } else {
        setStatus(current => current.startsWith('Preview:') ? 'Live in the cloud.' : current);
      }
    } catch (error) { setStatus(`Preview: ${message(error)}`); }
  }, [stage, selected, endpoint]);

  useEffect(() => {
    if (stage !== 'cloud') return;
    void refreshFrame();
  }, [stage, refreshFrame]);

  const send = async () => {
    if (!endpoint || !selected || !inventory) return;
    setBusy(true); setActivity([]);
    try {
      log('Preparing the selected tab and cookies…');
      if (!window.abra) throw new Error('Open the installed Abra Teleport desktop app.');
      const encoded = btoa(JSON.stringify([...cookieKeys].sort()));
      const prepared = await window.abra.sandbox('browser-up', {
        profile, url: selected.url, title: selected.title, 'tab-id': selected.id, cookies: encoded,
        ...(!protectedGoogleTab && cookieKeys.size === cookies.length ? { 'all-cookies': true } : {}),
        ...(!includeStorage || protectedGoogleTab ? { 'no-storage': true } : {}),
      });
      setSentCookieCount(prepared.cookie_count); setStage('cloud'); setFrame(null);
      log('Live in the sandbox.');
    } catch (error) { log(`Failed: ${message(error)}`); }
    finally { setBusy(false); }
  };

  const bringBack = async () => {
    if (!endpoint) return;
    setBusy(true);
    try {
      log('Sending the live browser back to this computer…');
      await window.abra?.sandbox('browser-down');
      setStage('pick'); setFrame(null); setTabs(await reload());
      log('Returned. The updated tab is open on this computer.');
    } catch (error) { log(`Failed: ${message(error)}`); }
    finally { setBusy(false); }
  };

  if (stage === 'cloud') return <section className="browser-cloud">
    <main className="preview-panel">
      <div className="preview-heading"><div><h2>{frame?.title || selected?.title || 'Cloud browser'}</h2><p>{frame?.url || selected?.url}</p></div><div className="preview-actions"><span className="live"><span className="dot online" />SANDBOX</span></div></div>
      <div className="preview"><SandboxPreview image={frame?.image} refresh={refreshFrame} report={log} /></div>
      <p className="hint">Click the browser preview to interact. Refresh to see changes made by your agent.</p>
    </main>
    <aside className="cloud-controls">
      <div><span className="eyebrow">IN THE CLOUD</span><h2>{selected?.host}</h2><p>{sentCookieCount} cookies sent</p><p>{includeStorage && !protectedGoogleTab ? 'Site storage included' : 'No site storage'}</p></div>
      {selected && isGitHub(selected.host) && frame?.githubSignedIn === false && <div className="warning">GitHub rejected this session. Bring it back, then retry with the recent Chrome profile and every cookie marked “Login session.”</div>}
      {selected && isVercel(selected.host) && frame?.vercelSignedIn === false && <div className="warning">Vercel rejected this session. Bring it back, refresh the cookies, and select every cookie marked “Login session.”</div>}
      {selected && isGoogleOrYouTube(selected.host) && <div className="warning">Google and YouTube account login is intentionally not moved. Replaying those login cookies can invalidate the session on this computer.</div>}
      <div className="divider" />
      <div className="spacer" />
      <button className="primary wide" disabled={busy} onClick={bringBack}>Bring back to this computer</button>
    </aside>
    <Activity status={status} lines={activity} busy={busy} />
  </section>;

  return <section className="browser-pick">
    <main className="tab-panel">
      <div className="section-title"><div><h2>Choose a Chrome tab</h2><p>{managed ? 'Sign in inside the Abra browser, then refresh tabs. Your regular browser stays separate.' : 'These are the tabs open in Chrome right now.'}</p></div><button className="secondary" disabled={busy} onClick={async () => setTabs(await reload())}>Refresh tabs</button></div>
      {managed && <button className="secondary" disabled={busy} onClick={async () => {
        setBusy(true);
        try { await local(['browser', 'open', '--headed']); setTabs(await reload()); log('Open your site and sign in, then refresh tabs.'); }
        catch (error) { log(message(error)); } finally { setBusy(false); }
      }}>Open Abra browser</button>}
      <div className="toolbar">
        <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search tabs" />
        <span className="muted">Cookies from</span>
        <div className="profile-list">{profiles.filter(item => managed || item.directory !== 'active').map(item => <button key={item.directory} className={profile === item.directory ? 'selected' : ''} onClick={() => chooseProfile(item.directory)}>{item.name}{item.lastUsed ? ' · recent' : ''}</button>)}</div>
      </div>
      <div className="tab-grid">{visibleTabs.map(tab => <button key={tab.id} className={`tab-card ${selected?.id === tab.id ? 'selected' : ''}`} disabled={busy} onClick={() => inspect(tab)}>
        <div className="tab-card-top"><span className="site-mark">{tab.host.split('.')[0].slice(0, 2).toUpperCase()}</span>{tab.active && <span className="open-label">OPEN</span>}</div>
        <strong>{tab.title || tab.host}</strong><span>{tab.host}</span><small>Window {tab.windowIndex} · Tab {tab.tabIndex}</small>
      </button>)}</div>
    </main>
    <aside className="cookie-panel">
      <h2>Send with this tab</h2>
      {!selected && <div className="empty">Pick a tab to see its cookies.</div>}
      {selected && <div className="selected-tab"><strong>{selected.title}</strong><span>{selected.url}</span></div>}
      {selected && !inventory && <div className="loading"><span className="spinner" />Reading site data…</div>}
      {inventory && <>
        {inventory.liveState?.available ? <div className="route-live"><span className="dot online" /><div><strong>Live tab state ready</strong><small>{inventory.liveState.media ? `${formatDuration(inventory.liveState.media.currentTime)} · ${inventory.liveState.media.paused ? 'paused' : 'playing'} · ${inventory.liveState.media.playbackRate}×` : 'Scroll position will move with this tab.'}</small></div></div> : inventory.liveState?.reason && <div className="warning">{inventory.liveState.reason}</div>}
        <div className="cookie-heading"><div><h3>Cookies</h3><span>{cookieKeys.size} of {cookies.length}</span></div><div><button onClick={() => selected && inspect(selected)}>Refresh</button><button disabled={protectedGoogleTab} onClick={() => setCookieKeys(new Set(cookies.map(cookie => cookie.key)))}>All</button><button onClick={() => setCookieKeys(new Set())}>None</button></div></div>
        <p className="hint">Values stay hidden.</p>
        <div className="cookie-list">{cookies.length ? cookies.map(cookie => {
          return <button className="cookie" key={cookie.key} disabled={protectedGoogleTab} onClick={() => toggleCookie(cookie.key)}><Check checked={!protectedGoogleTab && cookieKeys.has(cookie.key)} /><div><strong>{cookie.name}</strong><span>{cookie.domain}</span><div className="badges">{protectedGoogleTab && <i>Not transferred</i>}{((githubTab && isGitHubLoginCookie(cookie.name)) || (vercelTab && isVercelLoginCookie(cookie.name))) && <i>Login session</i>}{cookie.httpOnly && <i>HttpOnly</i>}{cookie.secure && <i>Secure</i>}{cookie.sameSite && <i>{cookie.sameSite}</i>}</div></div></button>;
        }) : <p className="muted">No matching cookies in this profile.</p>}</div>
        <label className="storage"><input type="checkbox" disabled={protectedGoogleTab} checked={includeStorage && !protectedGoogleTab} onChange={event => setIncludeStorage(event.target.checked)} /><span><strong>Include site storage</strong><small>{protectedGoogleTab ? 'Not transferred for Google or YouTube' : 'Captured when you send'}</small></span></label>
        {protectedGoogleTab && <div className="warning">For safety, Abra does not copy cookies or storage from Google or YouTube. The tab URL and playback position can still move.</div>}
        {warnings.length > 0 && <div className="warning">Some selected cookies may be bound to this device.</div>}
        {loginSite && !hasPrimaryLoginCookie && <div className="warning">This Chrome profile is not signed in to {loginSite}. Sign in, then refresh the cookies here.</div>}
        {loginSite && hasPrimaryLoginCookie && !loginReady && <div className="warning">Select every {loginSite} login-session cookie.</div>}
        <button className="primary wide" disabled={busy || !connected || !loginReady} onClick={send}>{loginReady ? 'Send tab to cloud' : `Select ${loginSite} login cookies`}</button>
      </>}
    </aside>
    <Activity status={status} lines={activity} busy={busy} />
  </section>;
}

function Activity({ status, lines, busy }: { status: string; lines: string[]; busy: boolean }) {
  return <footer className="activity"><div><span className="eyebrow">ACTIVITY</span>{busy && <span className="spinner small" />}</div><strong>{status}</strong><span>{lines.at(-2) || 'Abra will show each handoff here.'}</span></footer>;
}

function Codex({ endpoint, sessions, connected }: { endpoint: Endpoint | null; sessions: Session[]; connected: boolean }) {
  const initialSession = sessions[0] || null;
  const [selected, setSelected] = useState<Session | null>(initialSession);
  const [workspace, setWorkspace] = useState(initialSession?.cwd || '');
  const [workspaceAvailable, setWorkspaceAvailable] = useState(initialSession?.workspace_exists !== false);
  const [details, setDetails] = useState<SessionDetails | null>(null);
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [stage, setStage] = useState<'local' | 'cloud' | 'local-app'>('local');
  const [cloudApp, setCloudApp] = useState<AppInspection | null>(null);
  const [localApp, setLocalApp] = useState<LocalApp | null>(null);
  const [task, setTask] = useState(() => `Append codex-teleport-test=${new Date().toISOString()} to handoff.txt, preserving the existing lines. Then start the app server on port 3000 and leave it running.`);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string[]>([]);
  const [status, setStatus] = useState('Choose a completed session.');
  const log = (text: string) => { setStatus(text); setActivity(current => [...current, text]); };

  useEffect(() => {
    if (stage === 'cloud') return;
    if (!selected) { setDetails(null); return; }
    let current = true;
    setDetails(null); setDetailsBusy(true);
    void local<SessionDetails>(['codex', 'inspect', selected.session_id])
      .then(value => { if (current) setDetails(value); })
      .catch(error => { if (current) setStatus(`Failed to read session: ${message(error)}`); })
      .finally(() => { if (current) setDetailsBusy(false); });
    return () => { current = false; };
  }, [selected]);

  useEffect(() => {
    if (!endpoint?.provider) return;
    void window.abra?.sandbox('status').then(async result => {
      const active = result.active?.codex;
      if (!active) return;
      const session = sessions.find(s => s.session_id === active.session);
      if (session) setSelected(session);
      setWorkspace(active.workspace); setWorkspaceAvailable(true); setStage('cloud');
      setDetails(await window.abra!.sandbox('codex-inspect'));
      setCloudApp(await window.abra!.sandbox('app-inspect'));
    }).catch(error => setStatus(message(error)));
  }, [endpoint?.provider?.id]);

  const chooseSession = (session: Session) => {
    if (session.active_writer) return;
    setSelected(session);
    setWorkspace(session.cwd);
    setWorkspaceAvailable(session.workspace_exists !== false);
    if (session.workspace_exists === false) setStatus('This session’s original workspace is missing. Choose a replacement folder.');
  };

  const chooseWorkspace = async () => {
    if (!window.abra) return;
    const chosen = await window.abra.chooseWorkspace();
    if (!chosen) return;
    setWorkspace(chosen);
    setWorkspaceAvailable(true);
    setStatus('Replacement workspace selected.');
  };

  const sendToCloud = async () => {
    if (!endpoint || !selected || !workspaceAvailable || selected.active_writer) return;
    setBusy(true); setActivity([]);
    try {
      log('Sending the session and workspace to the cloud…');
      setDetails(await window.abra!.sandbox('codex-up', { session: selected.session_id, workspace }));
      setCloudApp(await window.abra!.sandbox('app-inspect')); setStage('cloud');
      log('The session and workspace are live in the sandbox.'); return;
    } catch (error) { log(`Failed: ${message(error)}`); }
    finally { setBusy(false); }
  };

  const runCloudTask = async () => {
    if (!selected || !task.trim() || !window.abra) return;
    setBusy(true);
    try {
      log('Codex is working in the cloud…');
      setDetails(await window.abra.sandbox('codex-run', { prompt: task.trim() }));
      setCloudApp(await window.abra.sandbox('app-inspect')); log('Sandbox task finished.'); return;
    } catch (error) { log(`Failed: ${message(error)}`); }
    finally { setBusy(false); }
  };

  const bringBack = async () => {
    if (!endpoint || !selected) return;
    setBusy(true);
    try {
      log('Bringing the session and workspace back…');
      const result = await window.abra!.sandbox('codex-down');
      setWorkspace(result.workspace); setDetails(result.details); setCloudApp(null); setStage('local');
      log(`Returned. The session and workspace are back at ${result.workspace}.`); return;
    } catch (error) { log(`Failed: ${message(error)}`); }
    finally { setBusy(false); }
  };

  const testLocally = async () => {
    if (!endpoint || !selected || !window.abra) return;
    setBusy(true);
    try {
      log('Bringing the workspace back and starting its captured app recipe…');
      const target = await window.abra.appTarget(folder(workspace), selected.session_id);
      const result = await window.abra.sandbox('codex-down', { workspace: target });
      setWorkspace(result.workspace); setWorkspaceAvailable(true); setDetails(result.details); setStage('local');
      const started = await window.abra.appStart(result.workspace);
      setLocalApp(started); setCloudApp(null); setStage('local-app'); log(`Running locally at ${started.url}`); return;
    } catch (error) { log(`Failed: ${message(error)}`); }
    finally { setBusy(false); }
  };

  const stopLocalApp = async () => {
    if (window.abra) await window.abra.appStop();
    setLocalApp(null); setStage('local'); log('Local app stopped. The restored files remain on this computer.');
  };

  return <section className="codex-layout">
    <aside className="session-list"><div><h2>{stage === 'cloud' ? 'Session in cloud' : stage === 'local-app' ? 'Testing locally' : 'Codex sessions'}</h2><p>{stage === 'cloud' ? 'Run tasks, test locally, or bring it back.' : stage === 'local-app' ? 'The restored app is running on this computer.' : 'Pick a completed session by its latest prompt.'}</p></div>{sessions.slice(0, 30).map(session => <button key={session.session_id} disabled={stage !== 'local' || session.active_writer === true} className={`${selected?.session_id === session.session_id ? 'selected ' : ''}${session.workspace_exists === false ? 'missing ' : ''}${session.active_writer ? 'active-writer' : ''}`} onClick={() => chooseSession(session)}><strong>{session.last_prompt || folder(session.cwd)}</strong><span>{folder(session.cwd)} · {formatBytes(session.bytes)}</span><small>{session.active_writer ? 'Open in Codex · finish or close it before moving' : `${session.workspace_exists === false ? 'Workspace missing · ' : ''}${formatDate(session.updated_at)} · ${shortID(session.session_id)}`}</small></button>)}</aside>
    <main className="task-panel">
      <div className="codex-heading"><div><span className="eyebrow">{stage === 'cloud' ? 'IN THE CLOUD' : stage === 'local-app' ? 'LOCAL PREVIEW' : 'CODEX HANDOFF'}</span><h2>{stage === 'cloud' ? 'Session and workspace are live' : stage === 'local-app' ? 'App restored and running' : 'What will move'}</h2></div>{stage === 'cloud' ? <span className="cloud-badge"><span className="dot online" />CLOUD</span> : stage === 'local-app' ? <span className="local-badge"><span className="dot online" />LOCAL</span> : null}</div>
      {selected && <div className="transfer-manifest">
        <div><span className="transfer-icon">↗</span><span><strong>Codex conversation</strong><small>{details ? `${details.user_turns} user turns · ${formatBytes(selected.bytes)}` : `${formatBytes(selected.bytes)} session file`}</small></span></div>
        <div className={workspaceAvailable ? '' : 'workspace-missing'}><span className="transfer-icon">⌘</span><span><strong>{workspaceAvailable ? 'Complete workspace' : 'Workspace missing'}</strong><small>{workspace}</small></span>{stage === 'local' && <button className="workspace-button" onClick={chooseWorkspace}>{workspaceAvailable ? 'Change' : 'Choose folder'}</button>}</div>
        <p>Codex login, settings, OAuth files, and local databases stay on this computer.</p>
      </div>}
      {!workspaceAvailable && <div className="warning workspace-warning">The original folder no longer exists. Choose an existing workspace for this session before teleporting it.</div>}
      {selected?.active_writer && <div className="warning workspace-warning">This session is currently open in Codex. Finish or close it before moving it, or select another completed session.</div>}
      {stage !== 'local-app' && <div className="conversation-preview">
        <div><h3>Recent conversation</h3><span>{detailsBusy ? 'Reading…' : details ? `${details.messages.length} shown` : ''}</span></div>
        {details?.messages.length ? <div className="messages">{details.messages.map((item, index) => <div className={`message ${item.role}`} key={`${item.role}-${index}`}><strong>{item.role === 'user' ? 'You' : 'Codex'}</strong><p>{item.text}</p></div>)}</div> : <p className="muted">{detailsBusy ? 'Loading the selected session…' : 'No visible conversation messages found.'}</p>}
      </div>}
      {stage === 'cloud' ? <>
        <div className={`server-detected ${cloudApp?.selected ? 'ready' : ''}`}><span className={cloudApp?.selected ? 'dot online' : 'dot'} /><div><strong>{cloudApp?.selected ? `App server · localhost:${cloudApp.selected.ports[0]}` : 'No app server detected yet'}</strong><small>{cloudApp?.selected ? cloudApp.selected.argv.join(' ') : 'Ask the cloud agent to create or start the app, then run the task.'}</small></div></div>
        <label className="task-label" htmlFor="cloud-task">What should Codex do in the cloud?</label>
        <textarea id="cloud-task" value={task} onChange={event => setTask(event.target.value)} placeholder="Enter a task for the cloud agent" />
        <div className="codex-cloud-actions"><button className="secondary" disabled={busy || !task.trim()} onClick={runCloudTask}>Run cloud task</button><button className="secondary" disabled={busy} onClick={bringBack}>Bring back files</button><button className="primary" disabled={busy || !cloudApp?.selected} onClick={testLocally}>Test locally</button></div>
      </> : stage === 'local-app' && localApp ? <>
        <div className="local-app-preview"><iframe src={localApp.url} title="Restored local app" /></div>
        <div className="local-app-details"><span><strong>{localApp.url}</strong><small>{localApp.command.join(' ')} · {localApp.workspace}</small></span><div><button className="secondary" onClick={() => void window.abra?.appOpen()}>Open in browser</button><button className="secondary" onClick={stopLocalApp}>Stop</button></div></div>
      </> : <div className="codex-submit"><span>The session and workspace will remain in the cloud until you bring them back.</span><button className="primary" disabled={!connected || busy || !selected || !workspaceAvailable || selected.active_writer === true} onClick={sendToCloud}>Send to cloud</button></div>}
    </main>
    <Activity status={status} lines={activity} busy={busy} />
  </section>;
}

export default function App() {
  const [mode, setMode] = useState<'browser' | 'codex'>('browser');
  const [connected, setConnected] = useState(false);
  const [endpoint, setEndpoint] = useState<Endpoint | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState('');

  const refreshTabs = async () => { const value = await local<Tab[]>(['browser', 'tabs']); setTabs(value); return value; };
  const refresh = async () => {
    setError('');
    try {
      if (!window.abra) throw new Error('Open the installed desktop app.');
      await local(['doctor']);
      const [nextProfiles, nextTabs, nextSessions] = await Promise.all([local<Profile[]>(['browser', 'profiles']), local<Tab[]>(['browser', 'tabs']), local<Session[]>(['codex', 'sessions'])]);
      setProfiles(nextProfiles); setTabs(nextTabs); setSessions(nextSessions);
      const provider = await window.abra.providerConfig();
      if (provider) {
        setEndpoint({ provider });
        await window.abra.sandbox('status');
      } else {
        setEndpoint(null); setConnected(false); return;
      }
      setConnected(true);
    } catch (caught) { setConnected(false); setError(message(caught)); }
  };

  useEffect(() => { void refresh(); }, []);

  return <div className="app-shell"><Header mode={mode} setMode={setMode} connected={connected} refresh={() => void refresh()} /><ProviderSettings onConnected={refresh} />{error && <div className="global-error">{error}</div>}{mode === 'browser' ? <Browser key={endpoint?.provider?.id || 'unpaired'} endpoint={endpoint} profiles={profiles} initialTabs={tabs} connected={connected} reload={refreshTabs} /> : <Codex key={endpoint?.provider?.id || 'unpaired'} endpoint={endpoint} sessions={sessions} connected={connected} />}</div>;
}
