#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserAdapterDirectory } from '../src/abra.js';

const domain = String(process.argv[2] || '').trim().replace(/^\./, '').toLowerCase();
const cdpUrl = process.env.ABRA_BROWSER_CDP_URL;
const contextId = process.env.ABRA_BROWSER_CONTEXT_ID;
const adapter = await browserAdapterDirectory();

if (!domain || !cdpUrl || !contextId) throw new Error('browser cloud action needs a domain and an active handoff');

const { CDP, attachPage, evalValue, waitForLoad } = await import(
  pathToFileURL(path.join(adapter, 'lib', 'cdp.js')).href
);
const cdp = await new CDP(cdpUrl).connect();

try {
  const pages = (await cdp.send('Target.getTargets')).targetInfos.filter(item => {
    if (item.type !== 'page' || item.browserContextId !== contextId) return false;
    try {
      const host = new URL(item.url).hostname;
      return host === domain || host.endsWith('.' + domain);
    } catch { return false; }
  });
  const base = pages[0]?.url || 'https://' + domain + '/';
  const url = new URL(base);
  const targetId = pages[0]?.targetId || (await cdp.send('Target.createTarget', {
    url: url.href,
    browserContextId: contextId
  })).targetId;
  const session = await attachPage(cdp, targetId);
  await waitForLoad(cdp, session);
  await evalValue(cdp, session, 'localStorage.setItem("abra_cloud_roundtrip", new Date().toISOString())').catch(() => {});
  url.searchParams.set('abra-cloud', '1');
  await cdp.send('Target.createTarget', {
    url: url.href,
    browserContextId: contextId
  });
  process.stdout.write(JSON.stringify({ changed: domain, addedTab: url.href }) + '\n');
} finally {
  cdp.close();
}
