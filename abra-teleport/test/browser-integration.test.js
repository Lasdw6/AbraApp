import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { abra, ensureDaemon, stopDaemon } from '../src/abra.js';
import { connectAgent, listAgents, agentRemote } from '../src/agent.js';
import { browserReceive, browserSend } from '../src/browser.js';
import { ensureChrome, stopChrome } from '../src/chrome.js';
import { capture } from '../../abra/adapters/browser-session/lib/browser.js';
import { CDP, attachPage, evalValue, waitForLoad } from '../../abra/adapters/browser-session/lib/cdp.js';

const enabled = process.env.ABRA_TELEPORT_BROWSER_INTEGRATION === '1';

async function selectDevice(home) {
  process.env.ABRA_TELEPORT_HOME = home;
  delete process.env.ABRA_TELEPORT_ABRA_ROOT;
  delete process.env.ABRA_BROWSER_DATA_DIR;
}

async function withServer() {
  const server = http.createServer((_request, response) => {
    const body = '<!doctype html><title>Abra browser round trip</title><input id=typing autofocus><script>localStorage.setItem("booted","yes")</script>';
    response.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
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

test('two Abra daemons round-trip browser tabs, cookies, and storage', { skip: !enabled, timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-teleport-browser-'));
  const homeA = path.join(root, 'a');
  const homeB = path.join(root, 'b');
  const original = { ...process.env };
  process.env.ABRA_BIN ||= path.resolve(import.meta.dirname, '..', '..', 'abra', 'target', 'debug', 'abra');
  process.env.ABRA_BROWSER_ADAPTER ||= path.resolve(import.meta.dirname, '..', '..', 'abra', 'adapters', 'browser-session');
  const web = await withServer();
  try {
    await selectDevice(homeA);
    const statusA = await ensureDaemon();
    const chromeA = await ensureChrome({ headless: true });
    await seedBrowser(chromeA.wsUrl, web.url);

    const ticket = (await abra(['pair', 'ticket'])).ticket;
    await selectDevice(homeB);
    const statusB = await connectAgent(ticket, 'browser sandbox');
    await selectDevice(homeA);
    const [agent] = await listAgents();
    const sent = await browserSend(statusB.peer_id, { domains: '127.0.0.1', headless: true, timeout: 30000 });
    const receivedB = JSON.parse(await agentRemote(agent, ['browser', 'receive', sent.snapshot_id]));
    await agentRemote(agent, ['browser', 'input', JSON.stringify({ text: 'typed through Abra' })]);
    await changeCloudBrowser(receivedB.cdp, receivedB.browser_context_id);
    const cloudState = await capture(receivedB.cdp, {}, { browserContextId: receivedB.browser_context_id });
    assert.equal(cloudState.cookies.find(cookie => cookie.name === 'abra_auth')?.value, 'cloud');
    assert.equal(cloudState.origins.find(origin => origin.origin.startsWith('http://127.0.0.1:'))?.localStorage.find(item => item.name === 'roundtrip')?.value, 'cloud');
    await agentRemote(agent, ['browser', 'down']);

    await selectDevice(homeA);
    const returned = await browserReceive(undefined, { allow: '127.0.0.1', headless: true });
    const returnedState = await capture(returned.cdp, {}, { browserContextId: returned.browser_context_id });
    assert.equal(returnedState.cookies.find(cookie => cookie.name === 'abra_auth')?.value, 'cloud');
    assert.equal(returnedState.origins.find(origin => origin.origin.startsWith('http://127.0.0.1:'))?.localStorage.find(item => item.name === 'roundtrip')?.value, 'cloud');
    assert.ok(returnedState.tabs.some(tab => tab.url.startsWith(web.url)));
  } finally {
    await new Promise(resolve => web.server.close(resolve));
    await selectDevice(homeA); await stopChrome().catch(() => {}); await stopDaemon().catch(() => {});
    await selectDevice(homeB); await stopChrome().catch(() => {}); await stopDaemon().catch(() => {});
    Object.keys(process.env).forEach(key => { if (!(key in original)) delete process.env[key]; });
    Object.assign(process.env, original);
    await rm(root, { recursive: true, force: true });
  }
});
