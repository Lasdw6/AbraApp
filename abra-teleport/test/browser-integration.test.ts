import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { abra, ensureDaemon, stopDaemon } from '../build/src/abra.js';
import { connectAgent, listAgents, agentRemote } from '../build/src/agent.js';
import { browserStatus, browserPrepare, browserReceive, browserRevoke, browserSend } from '../build/src/browser.js';
import { ensureChrome, stopChrome } from '../build/src/chrome.js';
import { capture } from '../../abra/adapters/browser-session/lib/browser.js';
import { CDP, attachPage, evalValue, waitForLoad } from '../../abra/adapters/browser-session/lib/cdp.js';

import { browserChromeTabs, browserCookieInventory, selectedBrowserState } from '../build/src/browser-source.js';

import { sandboxCommand } from '../build/src/sandbox.js';

const enabled = process.env.ABRA_TELEPORT_BROWSER_INTEGRATION === '1';

async function selectDevice(home) {
  process.env.ABRA_TELEPORT_HOME = home;
  delete process.env.ABRA_TELEPORT_ABRA_ROOT;
  delete process.env.ABRA_BROWSER_DATA_DIR;
}

async function withServer(tls?: { key: Buffer; cert: Buffer }) {
  const serve = tls ? handler => https.createServer(tls, handler) : handler => http.createServer(handler);
  const server = serve((_request, response) => {
    const body = '<!doctype html><title>Abra browser round trip</title><input id=typing autofocus><script>localStorage.setItem("booted","yes")</script>';
    response.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, url: `${tls ? 'https' : 'http'}://127.0.0.1:${address.port}/` };
}

async function seedBrowser(wsUrl, url) {
  const cdp = await new CDP(wsUrl).connect();
  try {
    const targetId = (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
    const session = await attachPage(cdp, targetId);
    await cdp.send('Page.navigate', { url }, session);
    await waitForLoad(cdp, session);
    await evalValue(cdp, session, 'localStorage.setItem("roundtrip", "local")');
    await cdp.send('Storage.setCookies', { cookies: [{ name: 'abra_auth', value: 'local', domain: '127.0.0.1', path: '/', httpOnly: true, secure: false }] });
  } finally { cdp.close(); }
}

async function changeCloudBrowser(wsUrl, contextId) {
  const cdp = await new CDP(wsUrl).connect();
  try {
    const targets = (await cdp.send('Target.getTargets')).targetInfos.filter(item => item.type === 'page' && item.browserContextId === contextId && item.url.startsWith('http://127.0.0.1:'));
    assert.ok(targets.length > 0);
    const session = await attachPage(cdp, targets[0].targetId);
    await waitForLoad(cdp, session);
    await evalValue(cdp, session, 'localStorage.setItem("roundtrip", "cloud")');
    await cdp.send('Storage.setCookies', { cookies: [{ name: 'abra_auth', value: 'cloud', domain: '127.0.0.1', path: '/', httpOnly: true, secure: false }], browserContextId: contextId });
  } finally { cdp.close(); }
}

test('handoff reuses a sandbox browser, returns the tab, and preserves existing tabs and cookies', { skip: !enabled, timeout: 180000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-teleport-browser-'));
  const homeA = path.join(root, 'a');
  const homeB = path.join(root, 'b');
  const providerHome = path.join(root, 'provider');
  const original = { ...process.env };
  process.env.ABRA_BIN ||= path.resolve(import.meta.dirname, '..', '..', 'abra', 'target', 'debug', process.platform === 'win32' ? 'abra.exe' : 'abra');
  process.env.ABRA_BROWSER_ADAPTER ||= path.resolve(import.meta.dirname, '..', '..', 'abra', 'adapters', 'browser-session');
  const web = await withServer();
  try {
    await selectDevice(homeA);
    const statusA = await ensureDaemon();
    const chromeA = await ensureChrome({ headless: true });
    await seedBrowser(chromeA.wsUrl, web.url);

    const ticket = (await abra(['pair', 'ticket'])).ticket;
    await selectDevice(providerHome);
    const providerChrome = await ensureChrome({ headless: true });
    await seedBrowser(providerChrome.wsUrl, web.url);
    process.env.ABRA_TELEPORT_CDP_URL = providerChrome.wsUrl;
    await selectDevice(homeB);
    const statusB = await connectAgent(ticket, 'browser sandbox');
    delete process.env.ABRA_TELEPORT_CDP_URL;
    await selectDevice(homeA);
    const [agent] = await listAgents();
    process.env.ABRA_TELEPORT_BROWSER_SOURCE = 'managed';
    const selected = (await browserChromeTabs()).find(tab => tab.url === web.url);
    const prepared = await sandboxCommand('browser-up', agent, { profile: 'active', url: web.url, 'tab-id': selected.id, 'all-cookies': true });
    assert.equal(prepared.cookie_count, 1);
    const remoteStatus = JSON.parse(await agentRemote(agent, ['browser', 'status']));
    assert.equal(remoteStatus.chrome.owned, false);
    assert.equal(remoteStatus.chrome.wsUrl, providerChrome.wsUrl);
    const receivedB = { cdp: remoteStatus.chrome.wsUrl, browser_context_id: remoteStatus.handoff.active_context_id };
    await agentRemote(agent, ['browser', 'input', JSON.stringify({ text: 'typed through Abra' })]);
    await changeCloudBrowser(receivedB.cdp, receivedB.browser_context_id);
    const cloudState = await capture(receivedB.cdp, {}, { browserContextId: receivedB.browser_context_id });
    assert.equal(cloudState.cookies.find(cookie => cookie.name === 'abra_auth')?.value, 'cloud');
    assert.equal(cloudState.origins.find(origin => origin.origin.startsWith('http://127.0.0.1:'))?.localStorage.find(item => item.name === 'roundtrip')?.value, 'cloud');
    await sandboxCommand('browser-down', agent, { headless: true });
    const untouched = await capture(providerChrome.wsUrl, {});
    assert.equal(untouched.cookies.find(cookie => cookie.name === 'abra_auth')?.value, 'local', 'provider cookies are unchanged');
    assert.equal(untouched.origins[0].localStorage.find(item => item.name === 'roundtrip')?.value, 'local', 'provider storage is unchanged');
    assert.ok(untouched.tabs.some(tab => tab.url === web.url), 'provider tabs remain open');
    const inspect = await new CDP(providerChrome.wsUrl).connect();
    try { assert.ok(!(await inspect.send('Target.getBrowserContexts')).browserContextIds.includes(receivedB.browser_context_id), 'only the imported context was removed'); } finally { inspect.close(); }
    const localStatus = await browserStatus();
    const returned = { cdp: localStatus.chrome.wsUrl, browser_context_id: localStatus.handoff.active_context_id };
    const returnedState = await capture(returned.cdp, {}, { browserContextId: returned.browser_context_id });
    assert.equal(returnedState.cookies.find(cookie => cookie.name === 'abra_auth')?.value, 'cloud');
    assert.equal(returnedState.origins.find(origin => origin.origin.startsWith('http://127.0.0.1:'))?.localStorage.find(item => item.name === 'roundtrip')?.value, 'cloud');
    assert.ok(returnedState.tabs.some(tab => tab.url.startsWith(web.url)));
    const selectedAgain = (await browserChromeTabs()).find(tab => tab.url === web.url);
    const sentAgain = await sandboxCommand('browser-up', agent, { profile: 'active', url: web.url, 'tab-id': selectedAgain.id, 'all-cookies': true });
    assert.equal(sentAgain.transferred, true);
    await sandboxCommand('browser-down', agent, { headless: true });
    const revokeTab = (await browserChromeTabs()).find(tab => tab.url === web.url);
    await sandboxCommand('browser-up', agent, { profile: 'active', url: web.url, 'tab-id': revokeTab.id, 'all-cookies': true });
    const toRevoke = JSON.parse(await agentRemote(agent, ['browser', 'status']));
    const revoked = await sandboxCommand('browser-revoke', agent);
    assert.ok(revoked.revoked);
    assert.deepEqual((await sandboxCommand('status', agent)).active, {});
    const remaining = await new CDP(providerChrome.wsUrl).connect();
    try { assert.ok(!(await remaining.send('Target.getBrowserContexts')).browserContextIds.includes(toRevoke.handoff.active_context_id)); } finally { remaining.close(); }
    const afterRevoke = await capture(providerChrome.wsUrl, {});
    assert.equal(afterRevoke.cookies.find(cookie => cookie.name === 'abra_auth')?.value, 'local');
    assert.ok(afterRevoke.tabs.some(tab => tab.url === web.url));
    assert.equal((await sandboxCommand('browser-revoke', agent)).already_revoked, true, 'revocation can be retried');

    // Two handoffs coexist; operations must address the selected context only.
    const sourceTab = (await browserChromeTabs()).find(tab => tab.url === web.url)!;
    const one = await sandboxCommand('browser-up', agent, { profile: 'active', url: web.url, 'tab-id': sourceTab.id, 'all-cookies': true });
    const two = await sandboxCommand('browser-up', agent, { profile: 'active', url: web.url, 'tab-id': sourceTab.id, 'all-cookies': true });
    assert.notEqual(one.session.id, two.session.id);
    assert.equal((await sandboxCommand('status', agent)).active.browsers.length, 2);
    await assert.rejects(sandboxCommand('browser-down', agent), /Choose which/);
    await assert.rejects(sandboxCommand('browser-revoke', agent, { session_id: 'f'.repeat(32) }), /no longer active/);
    await sandboxCommand('browser-revoke', agent, { session_id: one.session.id });
    const other = JSON.parse(await agentRemote(agent, ['browser', 'status']));
    assert.equal(other.sessions.length, 1);
    assert.equal(other.sessions[0].active_context_id, two.session.id);
    assert.ok((await capture(providerChrome.wsUrl, {}, { browserContextId: two.session.id })).tabs.length);
    await sandboxCommand('browser-down', agent, { session_id: two.session.id, headless: true });
    assert.deepEqual((await sandboxCommand('status', agent)).active, {});

    // Pull an original provider tab, then let the agent initiate another send.
    const cloudTabs = await sandboxCommand('browser-tabs', agent);
    const originalTab = cloudTabs.tabs.find(tab => tab.url === web.url)!;
    assert.ok(originalTab);
    await sandboxCommand('browser-pull', agent, { tab_id: originalTab.id, headless: true });
    assert.ok((await capture(providerChrome.wsUrl, {})).tabs.some(tab => tab.url === web.url));
    const pushed = JSON.parse(await agentRemote(agent, ['browser', 'send-tab', originalTab.id]));
    assert.ok((await sandboxCommand('browser-incoming', agent)).incoming.some(item => item.id === pushed.snapshot_id));
    await sandboxCommand('browser-accept', agent, { id: pushed.snapshot_id, headless: true });
    assert.ok(!(await sandboxCommand('browser-incoming', agent)).incoming.some(item => item.id === pushed.snapshot_id));
    const returnedSessions = (await browserStatus()).sessions;
    assert.ok(returnedSessions.length >= 3, 'opening another returned tab preserves previously returned tabs');
    const pushedSession = returnedSessions.find(item => item.received_snapshot_id === pushed.snapshot_id)!;
    const pushedState = await capture((await browserStatus()).chrome.wsUrl, {}, { browserContextId: pushedSession.active_context_id });
    assert.equal(pushedState.cookies.find(cookie => cookie.name === 'abra_auth')?.value, 'local');
    assert.equal(pushedState.origins[0].localStorage.find(item => item.name === 'roundtrip')?.value, 'local');

  } finally {
    await new Promise(resolve => web.server.close(resolve));
    await selectDevice(homeA); await stopChrome().catch(() => {}); await stopDaemon().catch(() => {});
    await selectDevice(homeB); await stopChrome().catch(() => {}); await stopDaemon().catch(() => {});
    await selectDevice(providerHome); await stopChrome().catch(() => {});
    Object.keys(process.env).forEach(key => { if (!(key in original)) delete process.env[key]; });
    Object.assign(process.env, original);
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});


test('managed browser selects one tab, scopes cookies/storage, and rejects a changed target', { skip: !enabled, timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-managed-selection-'));
  const original = { ...process.env };
  const web = await withServer();
  process.env.ABRA_TELEPORT_HOME = root;
  process.env.ABRA_TELEPORT_BROWSER_SOURCE = 'managed';
  process.env.ABRA_BIN ||= path.resolve(import.meta.dirname, '../../abra/target/debug', process.platform === 'win32' ? 'abra.exe' : 'abra');
  process.env.ABRA_BROWSER_ADAPTER ||= path.resolve(import.meta.dirname, '../../abra/adapters/browser-session');
  let cdp;
  try {
    assert.deepEqual(await browserChromeTabs(), []);
    const chrome = await ensureChrome({ headless: true });
    await seedBrowser(chrome.wsUrl, web.url);
    cdp = await new CDP(chrome.wsUrl).connect();
    const selected = (await browserChromeTabs()).find(tab => tab.url === web.url);
    assert.ok(selected);
    const selectedSession = await attachPage(cdp, selected.id);
    await evalValue(cdp, selectedSession, 'sessionStorage.setItem("private-tab", "selected")');
    const other = await cdp.send('Target.createTarget', { url: web.url });
    const otherSession = await attachPage(cdp, other.targetId);
    await waitForLoad(cdp, otherSession);
    await evalValue(cdp, otherSession, 'sessionStorage.setItem("private-tab", "other")');
    await cdp.send('Storage.setCookies', { cookies: [{ name: 'unrelated', value: 'secret', domain: 'example.org', path: '/' }] });
    const inventory = await browserCookieInventory('active', web.url, '', selected.id);
    const cookies = inventory.domains.flatMap(domain => domain.cookies);
    assert.ok(cookies.some(cookie => cookie.name === 'abra_auth'));
    assert.ok(!cookies.some(cookie => cookie.name === 'unrelated'));
    assert.ok(!JSON.stringify(inventory).includes('secret'));
    const keys = cookies.filter(cookie => cookie.name === 'abra_auth').map(cookie => cookie.key);
    const state = await selectedBrowserState('active', web.url, '', keys, true, selected.id);
    assert.deepEqual(state.cookies.map(cookie => cookie.name), ['abra_auth']);
    assert.equal(state.tabs.length, 1);
    assert.equal(state.origins[0].sessionStorage.find(item => item.name === 'private-tab').value, 'selected');
    const withoutStorage = await selectedBrowserState('active', web.url, '', [], false, selected.id);
    assert.deepEqual(withoutStorage.cookies, []);
    assert.deepEqual(withoutStorage.origins, []);
    const prepared = await browserPrepare({ profile: 'active', url: web.url, 'tab-id': selected.id,
      cookies: Buffer.from(JSON.stringify(keys)).toString('base64url') });
    assert.equal(prepared.prepared, true);
    assert.equal(prepared.cookie_count, 1);
    await browserRevoke();
    await cdp.send('Page.navigate', { url: web.url + 'changed' }, selectedSession);
    await waitForLoad(cdp, selectedSession);
    await assert.rejects(selectedBrowserState('active', web.url, '', keys, true, selected.id), /changed/);
  } finally {
    cdp?.close();
    await stopChrome().catch(() => {});
    await stopDaemon().catch(() => {});
    await new Promise(resolve => web.server.close(resolve));
    Object.keys(process.env).forEach(key => { if (!(key in original)) delete process.env[key]; });
    Object.assign(process.env, original);
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

test('manual override sends selected restricted cookies and storage through a real round trip', { skip: !enabled, timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-ov-'));
  const homes = [path.join(root, 'a'), path.join(root, 'b')];
  const original = { ...process.env };
  await promisify(execFile)('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1']);
  const web = await withServer({ key: await readFile(path.join(root, 'key.pem')), cert: await readFile(path.join(root, 'cert.pem')) });
  const fixtureChrome = path.join(root, 'chrome');
  await writeFile(fixtureChrome, '#!/bin/bash\nexec \"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\" --ignore-certificate-errors \"$@\"\n', { mode: 0o700 });
  process.env.CHROME_BIN = fixtureChrome;
  process.env.ABRA_BIN = path.resolve(import.meta.dirname, '../../abra/target/release/abra');
  process.env.ABRA_BROWSER_ADAPTER = path.resolve(import.meta.dirname, '../../abra/adapters/browser-session');
  process.env.ABRA_TELEPORT_TRANSPORT = 'tcp';
  process.env.ABRA_TELEPORT_BROWSER_SOURCE = 'managed';
  delete process.env.ABRA_TELEPORT_CDP_URL;
  try {
    await selectDevice(homes[0]); await ensureDaemon();
    const source = await ensureChrome({ headless: true });
    await seedBrowser(source.wsUrl, web.url);
    const cdp = await new CDP(source.wsUrl).connect();
    try { await cdp.send('Storage.setCookies', { cookies: [{ name: 'device_bound_session', value: 'fixture', domain: '127.0.0.1', path: '/', httpOnly: true, secure: true }] }); }
    finally { cdp.close(); }
    const ticket = (await abra(['pair', 'ticket'])).ticket;
    await selectDevice(homes[1]); await connectAgent(ticket, 'override fixture');
    await ensureChrome({ headless: true });
    await selectDevice(homes[0]);
    const [agent] = await listAgents();
    const tab = (await browserChromeTabs()).find(item => item.url === web.url)!;
    const base = { profile: 'active', url: web.url, 'tab-id': tab.id };
    const normal = await sandboxCommand('browser-up', agent, { ...base, 'all-cookies': true });
    assert.equal(normal.cookie_count, 1, 'default excludes the restricted cookie');
    await sandboxCommand('browser-revoke', agent, { session_id: normal.session.id });
    const inventory = await browserCookieInventory('active', web.url, '', tab.id);
    const key = inventory.domains.flatMap(item => item.cookies).find(cookie => cookie.name === 'device_bound_session')!.key;
    const overridden = await sandboxCommand('browser-up', agent, { ...base, cookies: Buffer.from(JSON.stringify([key])).toString('base64url'), 'allow-non-portable': true });
    assert.equal(overridden.cookie_count, 1, 'only the selected cookie is transferred');
    const remote = JSON.parse(await agentRemote(agent, ['browser', 'status']));
    assert.equal(remote.handoff.allow_non_portable, true);
    const remoteState = await capture(remote.chrome.wsUrl, {}, { browserContextId: overridden.session.id });
    assert.deepEqual(remoteState.cookies.map(cookie => cookie.name), ['device_bound_session']);
    assert.equal(remoteState.origins[0].localStorage.find(item => item.name === 'roundtrip')?.value, 'local');
    await sandboxCommand('browser-down', agent, { session_id: overridden.session.id, headless: true });
    const local = await browserStatus();
    const returned = await capture(local.chrome.wsUrl, {}, { browserContextId: local.handoff.active_context_id });
    assert.equal(returned.cookies.find(cookie => cookie.name === 'device_bound_session')?.value, 'fixture');
    assert.equal(returned.origins[0].localStorage.find(item => item.name === 'roundtrip')?.value, 'local');
    const sourceTab = (await browserChromeTabs()).find(item => item.id === tab.id)!;
    const next = await sandboxCommand('browser-up', agent, { profile: 'active', url: web.url, 'tab-id': sourceTab.id, 'all-cookies': true });
    assert.equal(next.cookie_count, 1, 'override does not leak into the next transfer');
    await sandboxCommand('browser-revoke', agent, { session_id: next.session.id });
  } finally {
    await new Promise(resolve => web.server.close(resolve));
    for (const home of homes) { await selectDevice(home); await stopChrome().catch(() => {}); await stopDaemon().catch(() => {}); }
    Object.keys(process.env).forEach(key => { if (!(key in original)) delete process.env[key]; }); Object.assign(process.env, original);
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
