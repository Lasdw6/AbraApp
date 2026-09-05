import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserAdapterDirectory } from './abra.js';
import { chromeStatus, ensureChrome } from './chrome.js';
import { loadState } from './state.js';
import { exists, run } from './util.js';

const chromeRoot = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const chromeBinary = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profileStateEntries = [
  'Cookies',
  'Cookies-journal',
  'Cookies-wal',
  'Preferences',
  'Secure Preferences',
  'Local Storage',
  'Session Storage',
  'IndexedDB',
  'WebStorage',
  'Storage'
];

async function browserModules() {
  const adapter = await browserAdapterDirectory();
  const browser = await import(pathToFileURL(path.join(adapter, 'lib', 'browser.js')).href);
  const cdp = await import(pathToFileURL(path.join(adapter, 'lib', 'cdp.js')).href);
  const util = await import(pathToFileURL(path.join(adapter, 'lib', 'util.js')).href);
  return { ...browser, ...cdp, ...util };
}

async function browserUtil() {
  const adapter = await browserAdapterDirectory();
  return import(pathToFileURL(path.join(adapter, 'lib', 'util.js')).href);
}

async function rejectProfileSymlinks(root) {
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) throw new Error(`refusing Chrome profile containing symbolic link: ${path.basename(root)}`);
  if (!rootInfo.isDirectory()) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error(`refusing Chrome profile containing symbolic link: ${entry.name}`);
    if (info.isDirectory()) await rejectProfileSymlinks(file);
  }
}

async function copyProfileState(source, destination) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await Promise.all(profileStateEntries.map(async name => {
    const from = path.join(source, name);
    if (!await exists(from)) return;
    await rejectProfileSymlinks(from);
    await cp(from, path.join(destination, name), { recursive: true, dereference: false });
  }));
}

async function withHeadlessProfile(profile, fn) {
  const source = path.join(chromeRoot, profile);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'abra-teleport-profile-'));
  let child;
  try {
    await copyProfileState(source, path.join(temporary, profile));
    await cp(path.join(chromeRoot, 'Local State'), path.join(temporary, 'Local State'), { dereference: false }).catch(() => {});
    child = spawn(chromeBinary, [
      `--user-data-dir=${temporary}`,
      `--profile-directory=${profile}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ], { stdio: 'ignore' });
    let port;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        port = Number((await readFile(path.join(temporary, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
        if (port) break;
      } catch { /* Chrome is still starting. */ }
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!port) throw new Error('the copied Chrome profile did not start');
    const { browserWebSocketFromPort } = await browserModules();
    return await fn(await browserWebSocketFromPort(port));
  } finally {
    if (child) {
      const { stopChrome } = await browserModules();
      await stopChrome(child.pid, temporary).catch(() => {});
    }
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

const chromeTabsScript = `
const chrome = Application('Google Chrome');
if (!chrome.running()) JSON.stringify([]);
else JSON.stringify(chrome.windows().flatMap((window, windowIndex) =>
  window.tabs().map((tab, tabIndex) => ({
    id: String(window.id()) + ':' + String(tabIndex + 1),
    windowId: String(window.id()),
    windowIndex: windowIndex + 1,
    tabIndex: tabIndex + 1,
    title: tab.title(),
    url: tab.url(),
    active: window.activeTabIndex() === tabIndex + 1
  }))
));`;

const chromeLiveTabScript = `
function run(argv) {
  const chrome = Application('Google Chrome');
  const windowId = Number(argv[0]), tabIndex = Number(argv[1]);
  const windows = chrome.windows.whose({id: windowId})();
  if (!windows.length || !windows[0].tabs[tabIndex - 1]) throw new Error('The selected Chrome tab is no longer open.');
  const tab = windows[0].tabs[tabIndex - 1];
  const javascript = 'JSON.stringify((()=>{const media=[...document.querySelectorAll("video,audio")].find(x=>!x.paused)||document.querySelector("video,audio");return {scroll:{x:scrollX,y:scrollY,historyLength:history.length},media:media?{currentTime:media.currentTime,paused:media.paused,playbackRate:media.playbackRate,volume:media.volume,muted:media.muted}:null}})())';
  return JSON.stringify({url: tab.url(), title: tab.title(), runtime: JSON.parse(tab.execute({javascript}))});
}`;

export async function browserChromeTabs() {
  if (process.platform !== 'darwin') throw new Error('live Chrome tab discovery is currently available on macOS');
  const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', chromeTabsScript]);
  return JSON.parse(stdout)
    .filter(tab => { try { return ['http:', 'https:'].includes(new URL(tab.url).protocol); } catch { return false; } })
    .map(tab => ({ ...tab, host: new URL(tab.url).hostname.toLowerCase() }));
}

export async function browserProfiles() {
  const active = { directory: 'active', name: 'Abra capture window', account: null, avatar: null, managed: true };
  if (process.platform !== 'darwin') return [active];
  let info = {};
  let lastUsed = null;
  try {
    const localState = JSON.parse(await readFile(path.join(chromeRoot, 'Local State'), 'utf8'));
    info = localState.profile?.info_cache || {};
    lastUsed = localState.profile?.last_used || null;
  } catch { /* fall back to profile directories */ }

  const directories = (await readdir(chromeRoot, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)))
    .map(entry => entry.name);
  const profiles = [...new Set([...Object.keys(info), ...directories])]
    .filter(directory => directories.includes(directory))
    .map(directory => ({
      directory,
      name: info[directory]?.name || (directory === 'Default' ? 'Default' : directory),
      account: info[directory]?.user_name || null,
      avatar: info[directory]?.avatar_icon || null,
      lastUsed: directory === lastUsed
    }))
    .sort((a, b) => Number(b.lastUsed) - Number(a.lastUsed) || a.name.localeCompare(b.name));
  return [active, ...profiles];
}

function host(value) {
  try { return new URL(value).hostname.replace(/^\./, '').toLowerCase(); }
  catch { return ''; }
}

function cookieHost(cookie) {
  return String(cookie.domain || host(cookie.url)).replace(/^\./, '').toLowerCase();
}

function cookieKey(cookie) {
  return Buffer.from(JSON.stringify([cookieHost(cookie), cookie.path || '/', cookie.name, cookie.partitionKey || null])).toString('base64url');
}

function cookieAppliesTo(cookie, selectedURL) {
  const domain = cookieHost(cookie);
  const hostname = selectedURL.hostname.toLowerCase();
  if (!domain || !(hostname === domain || hostname.endsWith('.' + domain))) return false;
  if (cookie.secure && selectedURL.protocol !== 'https:') return false;
  const cookiePath = cookie.path || '/';
  return selectedURL.pathname === cookiePath
    || selectedURL.pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : cookiePath + '/');
}

function isGoogleOrYouTubeHost(value) {
  const hostname = String(value || '').replace(/^\./, '').toLowerCase();
  return hostname === 'youtube.com'
    || hostname.endsWith('.youtube.com')
    || hostname === 'google.com'
    || hostname.endsWith('.google.com')
    || /(^|\.)google\.[a-z]{2,}(?:\.[a-z]{2})?$/.test(hostname);
}

async function captureLiveTab(tabId, expectedURL) {
  const match = String(tabId || '').match(/^(\d+):(\d+)$/);
  if (!match || process.platform !== 'darwin') return { available: false, reason: 'Live tab capture is unavailable.' };
  try {
    const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', chromeLiveTabScript, '--', match[1], match[2]]);
    const live = JSON.parse(stdout);
    if (new URL(live.url).href !== new URL(expectedURL).href) throw new Error('The selected Chrome tab changed before capture.');
    return { available: true, ...live.runtime };
  } catch (error) {
    const reason = /Executing JavaScript through AppleScript is turned off/.test(error.message)
      ? 'In Chrome, enable View → Developer → Allow JavaScript from Apple Events, then refresh.'
      : error.message;
    return { available: false, reason };
  }
}

function parentDomain(hostname, candidates) {
  const matches = [...candidates].filter(candidate => hostname === candidate || hostname.endsWith('.' + candidate));
  return matches.sort((a, b) => b.length - a.length)[0] || hostname;
}

function summarize(state, profile, buildManifest) {
  const cookieDomains = new Set((state.cookies || []).map(cookieHost).filter(Boolean));
  const originDomains = new Set((state.origins || []).map(item => host(item.origin)).filter(Boolean));
  const tabDomains = new Set((state.tabs || []).map(item => host(item.url)).filter(Boolean));
  const known = new Set([...cookieDomains, ...originDomains, ...tabDomains]);
  const groups = new Map();
  const ensure = domain => {
    const key = parentDomain(domain, known);
    if (!groups.has(key)) groups.set(key, { domain: key, cookies: [], tabs: [], localStorage: [], sessionStorage: [], indexedDB: [] });
    return groups.get(key);
  };

  for (const cookie of state.cookies || []) {
    const domain = cookieHost(cookie);
    if (!domain) continue;
    ensure(domain).cookies.push({
      name: cookie.name,
      domain,
      path: cookie.path || '/',
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
      sameSite: cookie.sameSite || null,
      session: !cookie.expires || cookie.expires < 0,
      key: cookieKey(cookie)
    });
  }
  for (const tab of state.tabs || []) {
    const domain = host(tab.url);
    if (!domain) continue;
    ensure(domain).tabs.push({ title: tab.title || '(untitled)', url: tab.url });
  }
  for (const origin of state.origins || []) {
    const domain = host(origin.origin);
    if (!domain) continue;
    const group = ensure(domain);
    group.localStorage.push(...(origin.localStorage || []).map(item => item.name));
    group.sessionStorage.push(...(origin.sessionStorage || []).map(item => item.name));
    group.indexedDB.push(...(origin.indexedDB?.databases || []).map(database => database.name));
  }

  const manifest = buildManifest(state);
  const warnings = new Map((manifest.non_teleportable || []).map(item => [item.domain, item.reasons]));
  return {
    profile,
    capturedAt: new Date().toISOString(),
    domains: [...groups.values()]
      .map(group => ({
        ...group,
        cookies: group.cookies.sort((a, b) => a.name.localeCompare(b.name)),
        tabs: group.tabs.sort((a, b) => a.title.localeCompare(b.title)),
        localStorage: [...new Set(group.localStorage)].sort(),
        sessionStorage: [...new Set(group.sessionStorage)].sort(),
        indexedDB: [...new Set(group.indexedDB)].sort(),
        warnings: warnings.get(group.domain) || []
      }))
      .filter(group => group.cookies.length || group.tabs.length || group.localStorage.length || group.sessionStorage.length || group.indexedDB.length)
      .sort((a, b) => a.domain.localeCompare(b.domain))
  };
}

export async function browserInventory(profile) {
  if (profile === 'active') {
    const chrome = await ensureChrome({ headless: false });
    const state = await loadState();
    const browserContextId = state.browser.active_context_id && state.browser.chrome_pid === chrome.pid
      ? state.browser.active_context_id
      : undefined;
    const { capture, buildManifest } = await browserModules();
    const captured = await capture(chrome.wsUrl, {}, { browserContextId });
    return summarize(captured, profile, buildManifest);
  }
  if (process.platform !== 'darwin') throw new Error('Chrome profile scanning is currently available on macOS');
  const available = await browserProfiles();
  if (!available.some(item => item.directory === profile)) throw new Error('Chrome profile does not exist: ' + profile);
  const { capture, buildManifest } = await browserModules();
  const state = await withHeadlessProfile(profile, wsUrl => capture(wsUrl));
  return summarize(state, profile, buildManifest);
}

async function captureProfileTab(profile, url) {
  const selectedURL = new URL(url);
  if (!['http:', 'https:'].includes(selectedURL.protocol)) throw new Error('select an HTTP or HTTPS Chrome tab');
  const available = await browserProfiles();
  if (!available.some(item => item.directory === profile && item.directory !== 'active')) {
    throw new Error('select the Chrome profile that owns this tab');
  }
  const { capture, CDP, attachPage, waitForLoad } = await browserModules();
  const captured = await withHeadlessProfile(profile, async wsUrl => {
    const cdp = await new CDP(wsUrl).connect();
    try {
      const existing = (await cdp.send('Target.getTargets')).targetInfos.filter(item => item.type === 'page');
      for (const target of existing) await cdp.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {});
      const target = await cdp.send('Target.createTarget', { url: 'about:blank', background: false });
      const session = await attachPage(cdp, target.targetId);
      try {
        await cdp.send('Page.navigate', { url: selectedURL.href }, session);
        await waitForLoad(cdp, session);
      }
      finally { await cdp.send('Target.detachFromTarget', { sessionId: session }).catch(() => {}); }
    }
    finally { cdp.close(); }
    return capture(wsUrl);
  });
  const cookies = (captured.cookies || []).filter(cookie => cookieAppliesTo(cookie, selectedURL));
  const origins = (captured.origins || []).filter(item => {
    try { return new URL(item.origin).origin === selectedURL.origin; } catch { return false; }
  });
  return { selectedURL, state: { ...captured, cookies, origins, tabs: [] } };
}

export async function browserTabInventory(profile, url, title = '') {
  const { selectedURL, state } = await captureProfileTab(profile, url);
  state.tabs = [{ url: selectedURL.href, title: title || selectedURL.hostname, scroll: { x: 0, y: 0, historyLength: 1 } }];
  const { buildManifest } = await browserModules();
  return summarize(state, profile, buildManifest);
}

function sameSiteFromChrome(value) {
  return ({ 0: 'None', 1: 'Lax', 2: 'Strict' })[value];
}

async function chromeCookiesDatabase(profile) {
  for (const relative of ['Cookies', path.join('Network', 'Cookies')]) {
    const file = path.join(chromeRoot, profile, relative);
    if (await exists(file)) return file;
  }
  throw new Error(`Chrome cookie database does not exist for profile: ${profile}`);
}

export async function browserCookieInventory(profile, url, title = '', tabId = '') {
  if (process.platform !== 'darwin') throw new Error('Chrome cookie scanning is currently available on macOS');
  const selectedURL = new URL(url);
  if (!['http:', 'https:'].includes(selectedURL.protocol)) throw new Error('select an HTTP or HTTPS Chrome tab');
  const available = await browserProfiles();
  if (!available.some(item => item.directory === profile && item.directory !== 'active')) {
    throw new Error('select the Chrome profile that owns this tab');
  }

  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(await chromeCookiesDatabase(profile), { readOnly: true, timeout: 1000 });
  let rows;
  try {
    rows = database.prepare(`
      SELECT host_key AS domain, path, name,
        is_secure AS secure, is_httponly AS httpOnly,
        samesite AS sameSite, has_expires AS hasExpires,
        top_frame_site_key AS topFrameSiteKey,
        has_cross_site_ancestor AS hasCrossSiteAncestor
      FROM cookies
    `).all();
  } finally {
    database.close();
  }

  const cookies = rows.map(row => ({
    name: row.name,
    value: '',
    domain: row.domain,
    path: row.path || '/',
    secure: Boolean(row.secure),
    httpOnly: Boolean(row.httpOnly),
    sameSite: sameSiteFromChrome(row.sameSite),
    expires: row.hasExpires ? 1 : -1,
    ...(row.topFrameSiteKey ? {
      partitionKey: {
        topLevelSite: row.topFrameSiteKey,
        hasCrossSiteAncestor: Boolean(row.hasCrossSiteAncestor)
      }
    } : {})
  })).filter(cookie => cookieAppliesTo(cookie, selectedURL));
  const liveState = await captureLiveTab(tabId, selectedURL.href);
  const state = {
    cookies,
    origins: [],
    tabs: [{ url: selectedURL.href, title: title || selectedURL.hostname, scroll: { x: 0, y: 0, historyLength: 1 } }]
  };
  const { buildManifest } = await browserUtil();
  return { ...summarize(state, profile, buildManifest), liveState };
}

export async function selectedBrowserState(profile, url, title, selectedCookieKeys, includeStorage = true, tabId = '') {
  const requestedURL = new URL(url);
  if (!['http:', 'https:'].includes(requestedURL.protocol)) throw new Error('select an HTTP or HTTPS Chrome tab');
  const protectedGoogleState = isGoogleOrYouTubeHost(requestedURL.hostname);
  let selectedURL = requestedURL;
  let state;
  if (protectedGoogleState) {
    const available = await browserProfiles();
    if (!available.some(item => item.directory === profile && item.directory !== 'active')) {
      throw new Error('select the Chrome profile that owns this tab');
    }
    state = { cookies: [], origins: [], tabs: [] };
  } else {
    ({ selectedURL, state } = await captureProfileTab(profile, requestedURL.href));
    if (selectedCookieKeys !== null) {
      const allowed = new Set(selectedCookieKeys || []);
      state.cookies = state.cookies.filter(cookie => allowed.has(cookieKey(cookie)));
    }
  }
  if (!includeStorage || protectedGoogleState) state.origins = [];
  const liveState = await captureLiveTab(tabId, selectedURL.href);
  const tabURL = new URL(selectedURL.href);
  if (liveState.available && liveState.media && /(^|\.)youtube\.com$/i.test(tabURL.hostname)) {
    tabURL.searchParams.set('t', `${Math.max(0, Math.floor(liveState.media.currentTime || 0))}s`);
  }
  state.tabs = [{
    url: tabURL.href,
    title: title || selectedURL.hostname,
    scroll: liveState.available ? liveState.scroll : { x: 0, y: 0, historyLength: 1 },
    ...(liveState.available && liveState.media ? { media: liveState.media } : {})
  }];
  return state;
}

export async function ensureChromeProfile(profile) {
  if (profile === 'active') return null;
  const directory = path.join(chromeRoot, profile);
  if (!await exists(directory)) throw new Error('Chrome profile does not exist: ' + profile);
  return profile;
}
