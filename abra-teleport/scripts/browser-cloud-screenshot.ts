#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserAdapterDirectory } from '../src/abra.js';

const cdpUrl = process.env.ABRA_BROWSER_CDP_URL;
const contextId = process.env.ABRA_BROWSER_CONTEXT_ID;
const adapter = await browserAdapterDirectory();

if (!cdpUrl || !contextId) throw new Error('cloud preview needs an active browser handoff');

const { CDP, attachPage, evalValue, waitForLoad } = await import(
  pathToFileURL(path.join(adapter, 'lib', 'cdp.js')).href
);
const cdp = await new CDP(cdpUrl).connect();

try {
  const pages = (await cdp.send('Target.getTargets')).targetInfos
    .filter(item => item.type === 'page' && item.browserContextId === contextId && /^https?:/.test(item.url));
  const page = pages.at(-1);
  if (!page) throw new Error('the cloud browser has no page to preview');
  const session = await attachPage(cdp, page.targetId);
  try {
    await waitForLoad(cdp, session);
    await cdp.send('Page.enable', {}, session);
    const contextCookies = (await cdp.send('Storage.getCookies', { browserContextId: contextId })).cookies || [];
    const vercelAuthorized = contextCookies.some(cookie => cookie.name === 'authorization' && String(cookie.domain || '').replace(/^\./, '') === 'vercel.com');
    const pageState = await evalValue(cdp, session, `({
      title: document.title,
      githubSignedIn: location.hostname === 'github.com'
        ? Boolean(document.querySelector('meta[name="user-login"]')?.content)
        : null,
      isVercel: location.hostname === 'vercel.com'
    })`).catch(() => ({ title: page.title || '', githubSignedIn: null, isVercel: false }));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 72, fromSurface: true }, session);
    process.stdout.write(JSON.stringify({ title: pageState.title, url: page.url, githubSignedIn: pageState.githubSignedIn, vercelSignedIn: pageState.isVercel ? vercelAuthorized : null, image: shot.data }) + '\n');
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId: session }).catch(() => {});
  }
} finally {
  cdp.close();
}
