#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mode = process.argv[2];
const cdpUrl = process.env.ABRA_BROWSER_CDP_URL || process.argv[3];
const contextId = process.env.ABRA_BROWSER_CONTEXT_ID || process.argv[4];
const adapter = process.env.ABRA_BROWSER_ADAPTER
  || path.resolve(import.meta.dirname, '..', '..', 'abra', 'adapters', 'browser-session');

if (!['seed', 'mutate', 'inspect'].includes(mode) || !cdpUrl) {
  throw new Error('usage: demo-browser-state.js <seed|mutate|inspect> <cdp-url> [browser-context-id]');
}

const { CDP, attachPage, evalValue, waitForLoad } = await import(
  pathToFileURL(path.join(adapter, 'lib', 'cdp.js')).href
);
const cdp = await new CDP(cdpUrl).connect();

try {
  const targetOptions = contextId ? { browserContextId: contextId } : {};
  let targets = (await cdp.send('Target.getTargets')).targetInfos.filter(item =>
    item.type === 'page'
    && (!contextId || item.browserContextId === contextId)
    && item.url.startsWith('https://example.com')
  );

  if (!targets.length) {
    const created = await cdp.send('Target.createTarget', { url: 'https://example.com/?tab=primary', ...targetOptions });
    targets = (await cdp.send('Target.getTargets')).targetInfos.filter(item => item.targetId === created.targetId);
  }

  const session = await attachPage(cdp, targets[0].targetId);
  if (mode === 'seed') {
    await cdp.send('Page.navigate', { url: 'https://example.com/?tab=primary' }, session);
  }
  await waitForLoad(cdp, session);

  if (mode === 'seed') {
    await evalValue(cdp, session, 'localStorage.setItem("abra_roundtrip", "local-seed")');
    await cdp.send('Storage.setCookies', {
      cookies: [{ name: 'abra_demo', value: 'local-seed', domain: 'example.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }],
      ...targetOptions
    });
    await cdp.send('Target.createTarget', { url: 'https://example.com/?tab=second', ...targetOptions });
  }

  if (mode === 'mutate') {
    await evalValue(cdp, session, 'localStorage.setItem("abra_roundtrip", "cloud-updated")');
    await cdp.send('Storage.setCookies', {
      cookies: [{ name: 'abra_demo', value: 'cloud-updated', domain: 'example.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }],
      ...targetOptions
    });
    await cdp.send('Target.createTarget', { url: 'https://example.com/?tab=created-in-cloud', ...targetOptions });
  }

  const allTargets = (await cdp.send('Target.getTargets')).targetInfos.filter(item =>
    item.type === 'page'
    && (!contextId || item.browserContextId === contextId)
    && item.url.startsWith('https://example.com')
  );
  const cookies = (await cdp.send('Storage.getCookies', targetOptions)).cookies;
  const value = await evalValue(cdp, session, 'localStorage.getItem("abra_roundtrip")');
  const cookie = cookies.find(item => item.name === 'abra_demo' && item.domain.includes('example.com'));
  process.stdout.write(`${JSON.stringify({
    mode,
    local_storage: value,
    cookie: cookie ? { name: cookie.name, value: cookie.value, httpOnly: cookie.httpOnly, secure: cookie.secure } : null,
    tabs: allTargets.map(item => item.url).sort()
  }, null, 2)}\n`);
} finally {
  cdp.close();
}
