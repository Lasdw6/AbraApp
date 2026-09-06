// Preload used only by screenshot.cjs. Fakes the window.abra bridge with sample data.
const { contextBridge } = require('electron');

const scenario = (process.argv.find(arg => arg.startsWith('--abra-shot=')) || '--abra-shot=pick').split('=')[1];
const tabs = [
  { id: 't1', windowIndex: 1, tabIndex: 1, title: 'Lasdw6/fleet: Pull requests', url: 'https://github.com/Lasdw6/fleet/pulls', host: 'github.com', active: true },
  { id: 't2', windowIndex: 1, tabIndex: 2, title: 'Dashboard – Vercel', url: 'https://vercel.com/lasdw/abra', host: 'vercel.com', active: false },
  { id: 't3', windowIndex: 1, tabIndex: 3, title: 'React – The library for web and native user interfaces', url: 'https://react.dev/', host: 'react.dev', active: false },
  { id: 't4', windowIndex: 1, tabIndex: 4, title: 'Building a Rust CLI from scratch - YouTube', url: 'https://www.youtube.com/watch?v=abc', host: 'www.youtube.com', active: false },
  { id: 't5', windowIndex: 2, tabIndex: 1, title: 'Electron | Build cross-platform desktop apps', url: 'https://www.electronjs.org/', host: 'www.electronjs.org', active: false },
  { id: 't6', windowIndex: 2, tabIndex: 2, title: 'Hacker News', url: 'https://news.ycombinator.com/', host: 'news.ycombinator.com', active: false },
];
const profiles = [{ directory: 'Default', name: 'Vividh', account: 'vividh@example.com', lastUsed: true }, { directory: 'Profile 1', name: 'Work', account: null }];
const inventory = {
  profile: 'Default',
  domains: [{
    domain: 'github.com', localStorage: [], sessionStorage: [], indexedDB: [], warnings: [],
    cookies: [
      { key: '1', name: 'user_session', domain: '.github.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', session: false },
      { key: '2', name: '__Host-user_session_same_site', domain: 'github.com', path: '/', httpOnly: true, secure: true, sameSite: 'Strict', session: false },
      { key: '3', name: 'logged_in', domain: '.github.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', session: false },
      { key: '4', name: 'dotcom_user', domain: '.github.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', session: false },
      { key: '5', name: '_octo', domain: '.github.com', path: '/', httpOnly: false, secure: true, sameSite: 'Lax', session: false },
      { key: '6', name: 'tz', domain: 'github.com', path: '/', httpOnly: false, secure: true, sameSite: null, session: true },
      { key: '7', name: 'color_mode', domain: 'github.com', path: '/', httpOnly: false, secure: true, sameSite: null, session: false },
      { key: '8', name: 'preferred_color_mode', domain: 'github.com', path: '/', httpOnly: false, secure: true, sameSite: null, session: false },
    ],
  }],
};
const agent = { id: 'a1b2c3d4e5f6', peer_id: 'p', capsule_id: 'c', name: 'daytona-sandbox', platform: 'linux' };
const cloudStatus = ['cloud', 'offline', 'multi'].includes(scenario) ? { active: { browser: { id: 'A'.repeat(32), url: tabs[0].url, title: tabs[0].title, cookie_count: 8, include_storage: true } } } : { active: {} };

if (scenario === 'multi') cloudStatus.active.browsers = [cloudStatus.active.browser, { ...cloudStatus.active.browser, id: 'B'.repeat(32), title: tabs[1].title, url: tabs[1].url }];

contextBridge.exposeInMainWorld('abra', {
  providerConfig: async () => (scenario === 'unpaired' || scenario === 'command' ? null : agent),
  agentTicket: async () => ({ command: 'curl -fsSL https://abra.vividh.lol/install.sh | bash -s -- --ticket abc123', expires_in_seconds: 600, installs_cli: true }),
  exportInstaller: async () => null,
  connectionHealth: async () => (scenario === 'unpaired' || scenario === 'command' ? { agent_id: null, status: 'unpaired', last_seen: null, checked_at: new Date().toISOString(), error: null } : { agent_id: agent.id, status: scenario === 'offline' ? 'unreachable' : 'connected', last_seen: new Date().toISOString(), checked_at: new Date().toISOString(), error: null }),
  agentList: async () => [agent, { id: 'ff00aa11bb22', peer_id: 'p2', capsule_id: 'c2', name: 'firecracker-vm', platform: 'linux' }],
  agentSelect: async () => agent,
  sandbox: async (action) => {
    if (action === 'browser-incoming') return { incoming: scenario === 'remote' ? [{ id: 'a'.repeat(64), received_at: new Date().toISOString() }] : [] };
    if (action === 'browser-tabs') return { tabs };
    if (action === 'status') return cloudStatus;
    if (action === 'browser-up') return { transferred: true, cookie_count: 8, omitted_cookie_count: 0, session: { id: 'A'.repeat(32), url: tabs[0].url, title: tabs[0].title, cookie_count: 8, include_storage: true } };
    if (action === 'browser-down') return { returned: true };
    if (action === 'browser-revoke') return { revoked: true };
    return {};
  },
  local: async (args) => {
    if (args[1] === 'tabs') return JSON.stringify(tabs);
    if (args[1] === 'profiles') return JSON.stringify(profiles);
    if (args[1] === 'cookie-inventory') return JSON.stringify(inventory);
    return 'null';
  },
});
