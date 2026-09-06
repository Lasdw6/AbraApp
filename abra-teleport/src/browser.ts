import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { abra, browserAdapterDirectory, ensureDaemon, ensurePrivateMaterialization, waitForAck } from './abra.js';
import { browserMode, chromeStatus, ensureChrome, matchesBrowser, stopChrome as stopManagedChrome } from './chrome.js';
import { ensureChromeProfile, selectedBrowserState } from './browser-source.js';
import { chooseInbox } from './inbox.js';
import { paths } from './paths.js';
import { requireDiskSpace } from './disk-space.js';
import { loadState, updateState } from './state.js';
import { addBrowserSession, browserSessions, removeBrowserSession, selectBrowserSession } from './browser-sessions.js';
import { exists, flagList, readJson, run, runInteractive, sleep } from './util.js';
import { browserCandidates, browserEndpoint } from './browser-discovery.js';
import { managedTabs } from './managed-browser-source.js';

import type { BrowserTab } from './types.js';

const KIND = 'dev.abra.browser.session.v1';

function domainOptions(flags, receiving = false) {
  const included = flagList(receiving ? (flags.allow ?? flags.domains) : flags.domains);
  const excluded = flagList(receiving ? flags.deny : flags.exclude);
  if (!receiving && !included.length && flags['all-domains'] !== true) {
    throw new Error('pass --domains example.com or explicitly pass --all-domains');
  }
  const args: string[] = [];
  if (flags['allow-non-portable'] === true) args.push('--adapter-option', 'allow_non_portable=true');
  if (included.length) args.push('--adapter-option', `${receiving ? 'allow_domains' : 'include_domains'}=${included.join(',')}`);
  if (excluded.length) args.push('--adapter-option', `${receiving ? 'deny_domains' : 'exclude_domains'}=${excluded.join(',')}`);
  return { args, included, excluded, all: !included.length };
}

async function receiptFiles() {
  const directory = path.join(paths().browserData, 'receipts');
  if (!await exists(directory)) return [];
  return (await readdir(directory)).filter(name => name.endsWith('.json')).map(name => path.join(directory, name));
}

async function findNewReceipt(before, stateHash) {
  const old = new Set(before);
  for (let attempt = 0; attempt < 80; attempt++) {
    for (const file of await receiptFiles()) {
      if (old.has(file)) continue;
      const receipt = await readJson(file);
      if (receipt.source_bundle_sha256 === stateHash && path.basename(file, '.json') === receipt.install_id) return { file, receipt };
    }
    await sleep(50);
  }
  throw new Error('browser import succeeded but its new receipt could not be matched');
}

async function revokeReceipt(file) {
  const adapter = await browserAdapterDirectory();
  const executable = path.join(adapter, 'bin', 'abra-browser.js');
  const { stdout } = await run(process.execPath, [executable, 'revoke', file], {
    env: { ABRA_BROWSER_DATA_DIR: paths().browserData }
  });
  return stdout.trim();
}

export async function restoreTabLocations(cdpUrl, browserContextId, tabs: BrowserTab[] = []) {
  const wanted = tabs.flatMap(tab => {
    try {
      const url = new URL(tab.url);
      return ['http:', 'https:'].includes(url.protocol) ? [{ ...tab, url: url.href, origin: url.origin }] : [];
    } catch { return []; }
  });
  if (!wanted.length) return;
  const adapter = await browserAdapterDirectory();
  const { CDP, attachPage, waitForLoad, evalValue } = await import(pathToFileURL(path.join(adapter, 'lib', 'cdp.js')).href);
  const cdp = await new CDP(cdpUrl).connect();
  try {
    const available = (await cdp.send('Target.getTargets')).targetInfos
      .filter(target => target.type === 'page' && target.browserContextId === browserContextId);
    const used = new Set();
    for (const tab of wanted) {
      let target = available.find(candidate => !used.has(candidate.targetId) && (() => {
        try { return new URL(candidate.url).origin === tab.origin; } catch { return false; }
      })());
      target ||= available.find(candidate => !used.has(candidate.targetId));
      if (!target) {
        const created = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId, background: false });
        target = { targetId: created.targetId, url: 'about:blank' };
      }
      used.add(target.targetId);
      const session = await attachPage(cdp, target.targetId);
      try {
        await cdp.send('Page.navigate', { url: tab.url }, session);
        await waitForLoad(cdp, session);
        const x = Number.isFinite(tab.scroll?.x) ? tab.scroll!.x : 0;
        const y = Number.isFinite(tab.scroll?.y) ? tab.scroll!.y : 0;
        if (x || y) await evalValue(cdp, session, `window.scrollTo(${x}, ${y})`).catch(() => {});
        if (tab.media && Number.isFinite(tab.media.currentTime)) {
          const media = {
            currentTime: Math.max(0, tab.media.currentTime),
            paused: tab.media.paused !== false,
            playbackRate: Number.isFinite(tab.media.playbackRate) ? tab.media.playbackRate : 1,
            volume: Number.isFinite(tab.media.volume) ? Math.min(1, Math.max(0, tab.media.volume)) : 1,
            muted: Boolean(tab.media.muted)
          };
          await evalValue(cdp, session, `(async()=>{const wanted=${JSON.stringify(media)},deadline=Date.now()+10000;let item;while(Date.now()<deadline){item=[...document.querySelectorAll('video,audio')].find(x=>!x.paused)||document.querySelector('video,audio');if(item)break;await new Promise(resolve=>setTimeout(resolve,100))}if(!item)return false;item.currentTime=wanted.currentTime;item.playbackRate=wanted.playbackRate;item.volume=wanted.volume;item.muted=wanted.muted;if(wanted.paused)item.pause();else await item.play().catch(()=>{});return true})()`).catch(() => {});
        }
      } finally {
        await cdp.send('Target.detachFromTarget', { sessionId: session }).catch(() => {});
      }
    }
    for (const target of available.filter(candidate => !used.has(candidate.targetId))) {
      await cdp.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {});
    }
  } finally { cdp.close(); }
}

async function cookieOverrideSupported() {
  const adapter = await browserAdapterDirectory();
  return (await import(pathToFileURL(path.join(adapter, 'lib', 'util.js')).href)).supportsManualCookieOverride === true;
}

export async function browserPrepare(flags) {
  const allowNonPortable = flags['allow-non-portable'] === true;
  if (allowNonPortable && !await cookieOverrideSupported()) throw new Error('Update the browser adapter to use the manual override.');
  await requireDiskSpace(paths().home);
  await requireDiskSpace(paths().browserData);
  const profile = await ensureChromeProfile(flags.profile);
  if (!profile && flags.profile !== 'active') throw new Error('select a Chrome profile or the Abra capture window');
  const url = String(flags.url || '');
  const title = String(flags.title || '');
  let cookieKeys: string[] | null = null;
  if (flags['all-cookies'] !== true) {
    try { cookieKeys = JSON.parse(Buffer.from(String(flags.cookies || ''), 'base64url').toString('utf8')); }
    catch { throw new Error('the selected cookie list is invalid'); }
    if (!Array.isArray(cookieKeys) || cookieKeys.some(value => typeof value !== 'string')) throw new Error('the selected cookie list is invalid');
  }

  const current = await loadState();
  const chrome = await ensureChrome({ headless: true, reuse: false });
  const selected = await selectedBrowserState(flags.profile, url, title, cookieKeys, flags['no-storage'] !== true, flags['tab-id'], flags['source-cdp'], allowNonPortable);
  await mkdir(paths().home, { recursive: true, mode: 0o700 });
  const bundle = await mkdtemp(path.join(paths().home, 'browser-selection-'));
  const previousBrowserData = process.env.ABRA_BROWSER_DATA_DIR;
  process.env.ABRA_BROWSER_DATA_DIR = paths().browserData;
  try {
    const adapter = await browserAdapterDirectory();
    const { saveBundle } = await import(pathToFileURL(path.join(adapter, 'lib', 'util.js')).href);
    const { installBundle } = await import(pathToFileURL(path.join(adapter, 'lib', 'import.js')).href);
    const manifest = await saveBundle(bundle, selected, { source: 'selected-chrome-tab', sourceBrowser: 'Google Chrome profile copy', allowNonPortable });
    const portableCookieCount = manifest.domains.reduce((total, domain) => total + domain.cookie_count, 0);
    const omittedCookieCount = (manifest.non_teleportable || [])
      .filter(item => item.action === 'omitted')
      .reduce((total, item) => total + (item.cookie_count || 0), 0);
    const installed = await installBundle(bundle, { type: 'cdp', cdpUrl: chrome.wsUrl }, { requireLocalTrust: true, policy: { allowNonPortable } });
    try { await restoreTabLocations(chrome.wsUrl, installed.receipt.browser_context_id, selected.tabs); }
    catch (error) {
      await revokeReceipt(installed.receiptPath).catch(() => {});
      throw error;
    }
    await updateState(state => {
      state.browser = addBrowserSession(state.browser, {
        allow_non_portable: allowNonPortable, active_context_id: installed.receipt.browser_context_id, active_receipt: installed.receiptPath,
        chrome_pid: chrome.pid, chrome_ws_url: chrome.wsUrl,
        prepared: { profile, url, title, cookie_count: portableCookieCount, omitted_cookie_count: omittedCookieCount, include_storage: flags['no-storage'] !== true }
      });
    });
    return { prepared: true, profile, url, title, cookie_count: portableCookieCount, omitted_cookie_count: omittedCookieCount, origin_count: selected.origins.length, manifest };
  } finally {
    if (previousBrowserData === undefined) delete process.env.ABRA_BROWSER_DATA_DIR;
    else process.env.ABRA_BROWSER_DATA_DIR = previousBrowserData;
    await rm(bundle, { recursive: true, force: true });
  }
}

export async function browserSend(peer, flags, direction = 'up') {
  await requireDiskSpace(paths().home);
  await requireDiskSpace(paths().browserData);
  await ensureDaemon();
  const profile = typeof flags.profile === 'string' ? await ensureChromeProfile(flags.profile) : null;
  const chrome = profile ? null : await ensureChrome({ headless: browserMode(flags) });
  const policy = domainOptions(flags);
  const state = await loadState();
  const session = selectBrowserSession(state.browser, flags.session);
  if (session.allow_non_portable === true && flags['allow-non-portable'] !== true) policy.args.push('--adapter-option', 'allow_non_portable=true');
  const destinationPeer = peer || session.from || state.browser.last_sent?.peer;
  if (!destinationPeer) throw new Error(`browser ${direction} needs a peer id`);
  const args = ['send', destinationPeer, '--kind', KIND, '--source', profile ? `local:${profile}` : `cdp:${chrome.wsUrl}`, ...policy.args];
  if (session.active_context_id) {
    if (profile) throw new Error('revoke the active imported browser context before capturing a Chrome profile');
    if (!matchesBrowser(session, chrome)) throw new Error('the imported browser context belonged to an older Chrome process; receive the session again');
    args.push('--adapter-option', `browser_context_id=${session.active_context_id}`);
  }
  const sent = await abra(args);
  const ack = await waitForAck(sent.snapshot_id, Number(flags.timeout || 120000));
  await updateState(current => {
    current.browser.last_sent = {
      direction,
      peer: destinationPeer,
      snapshot_id: sent.snapshot_id,
      outbox_id: sent.outbox_id,
      domains: policy.included,
      all_domains: policy.all,
      profile,
      acknowledged_at: ack.updated_at
    };
  });
  return { ...sent, state: 'acked', peer: destinationPeer, direction, domains: policy.all ? 'all' : policy.included, profile };
}

export async function browserReceive(requestedId, flags) {
  if (flags['allow-non-portable'] === true && !await cookieOverrideSupported()) throw new Error('Update the browser adapter to use the manual override.');
  await requireDiskSpace(paths().home);
  await requireDiskSpace(paths().browserData);
  await ensureDaemon();
  if (flags.headless === true && flags.headed === true) throw new Error('choose either --headless or --headed');
  const chrome = await ensureChrome({ headless: browserMode(flags), proxy: flags.proxy });
  const item = await chooseInbox(KIND, requestedId, flags.from);
  const materialized = await ensurePrivateMaterialization(item.id);
  const before = await receiptFiles();
  const policy = domainOptions(flags, true);
  let accepted = false;
  try {
    await abra(['accept', item.id, materialized, '--destination', `cdp:${chrome.wsUrl}`, ...policy.args]);
    accepted = true;
    const manifest = await readJson(path.join(materialized, 'manifest.json'));
    const receivedState = await readJson(path.join(materialized, 'state.json'));
    const matched = await findNewReceipt(before, manifest.state_sha256);
    await restoreTabLocations(chrome.wsUrl, matched.receipt.browser_context_id, receivedState.tabs);
    await updateState(state => {
      state.browser = addBrowserSession(state.browser, {
        allow_non_portable: flags['allow-non-portable'] === true, active_context_id: matched.receipt.browser_context_id, active_receipt: matched.file,
        chrome_pid: chrome.pid, chrome_ws_url: chrome.wsUrl, from: item.from,
        received_snapshot_id: item.id, received_at: item.received_at
      });
    });
    await rm(materialized, { recursive: true, force: true });
    return {
      accepted: item.id,
      from: item.from,
      browser_context_id: matched.receipt.browser_context_id,
      receipt: matched.file,
      cdp: chrome.wsUrl,
      installed_origins: matched.receipt.origins,
      installed_cookies: matched.receipt.cookies
    };
  } catch (error) {
    const cleanupErrors: string[] = [];
    if (accepted) {
      const old = new Set(before);
      for (const file of (await receiptFiles()).filter(candidate => !old.has(candidate))) {
        await revokeReceipt(file).catch(cleanup => cleanupErrors.push(`${file}: ${cleanup.message}`));
      }
    }
    const cleanup = cleanupErrors.length ? `; context cleanup failed (${cleanupErrors.join('; ')})` : '';
    throw new Error(`${error.message}; retry handoff ${item.id}; received bundle kept at ${materialized}${cleanup}`);
  }
}

export async function browserRevoke(id?: string) {
  const state = await loadState();
  const session = selectBrowserSession(state.browser, id);
  if (!session.active_receipt) throw new Error('there is no active imported browser context');
  const output = await revokeReceipt(session.active_receipt);
  await updateState(current => { current.browser = removeBrowserSession(current.browser, session.active_context_id); });
  return { revoked: session.active_receipt, output };
}

export async function browserStatus() {
  const state = await loadState();
  const chrome = await chromeStatus();
  return { chrome, handoff: state.browser, sessions: browserSessions(state.browser), multiple_sessions: true, manual_cookie_override: await cookieOverrideSupported() };
}

export async function browserExec(command) {
  if (!command.length) throw new Error('browser exec needs a command after --');
  const state = await loadState();
  const chrome = await chromeStatus();
  if (!chrome || !state.browser.active_context_id || !matchesBrowser(state.browser, chrome)) {
    throw new Error('receive a browser handoff before running an agent command');
  }
  await runInteractive(command[0], command.slice(1), {
    env: {
      ABRA_BROWSER_CDP_URL: chrome.wsUrl,
      ABRA_BROWSER_CONTEXT_ID: state.browser.active_context_id
    }
  });
  return { completed: true, browser_context_id: state.browser.active_context_id };
}

export async function browserClose(flags: { force?: boolean } = {}) {
  const state = await loadState();
  // Closing a process would also close unrelated transferred tabs. Revoke each
  // imported context explicitly before closing or detaching the browser.
  if (browserSessions(state.browser).length) {
    if (!flags.force) throw new Error('revoke the active imported browser sessions before closing Chrome');
    return { stopped: false, kept: true };
  }
  return stopManagedChrome();
}

export async function sandboxBrowserTabs() {
  const current = await ensureChrome();
  const endpoints = new Set([current.wsUrl]);
  for (const candidate of await browserCandidates()) {
    try { endpoints.add((await browserEndpoint(candidate)).wsUrl); } catch { /* Browser exited. */ }
  }
  const tabs: Array<{ id: string; title: string; url: string; host: string; source: string }> = [];
  for (const source of endpoints) {
    try { tabs.push(...(await managedTabs(source)).map(tab => ({ ...tab, source }))); } catch { /* Browser exited. */ }
  }
  return tabs;
}

export async function browserSendTab(tabId: string) {
  const agent = await readJson(path.join(paths().home, 'agent.json'), null);
  if (!agent?.controller) throw new Error('Connect this sandbox to a laptop first.');
  const tab = (await sandboxBrowserTabs()).find(item => item.id === tabId);
  if (!tab) throw new Error('That sandbox tab is no longer available. Refresh the tab list.');
  await browserPrepare({ profile: 'active', url: tab.url, title: tab.title,
    'tab-id': tab.id, 'source-cdp': tab.source, 'all-cookies': true });
  const session = (await loadState()).browser.active_context_id;
  try { return await browserSend(agent.controller, { 'all-domains': true, session }, 'down'); }
  finally { await browserRevoke(session); }
}
