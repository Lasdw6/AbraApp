import { cachedFavicons } from './favicon-cache.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserAdapterDirectory } from './abra.js';
import { chromeStatus } from './chrome.js';
import { browserEndpoint } from './browser-discovery.js';

export function usesManagedBrowser() {
  return process.platform !== 'darwin' || process.env.ABRA_TELEPORT_BROWSER_SOURCE === 'managed';
}

async function connect(wsUrl?: string) {
  const chrome = wsUrl ? await browserEndpoint(wsUrl) : await chromeStatus();
  if (!chrome) throw new Error('Open the Abra browser, sign in to your site, then refresh tabs.');
  const adapter = await browserAdapterDirectory();
  const modules = await import(pathToFileURL(path.join(adapter, 'lib/cdp.js')).href);
  return { ...modules, cdp: await new modules.CDP(chrome.wsUrl).connect() };
}

export async function managedTabs(wsUrl?: string) {
  if (!wsUrl && !await chromeStatus()) return [];
  const { cdp } = await connect(wsUrl);
  try {
    const tabs = (await cdp.send('Target.getTargets')).targetInfos
      .filter(target => target.type === 'page' && /^https?:\/\//.test(target.url))
      .map((target, index) => ({ id: target.targetId, title: target.title, url: target.url,
        host: new URL(target.url).hostname.toLowerCase(), windowIndex: 1, tabIndex: index + 1, active: false }));
    const chrome = await chromeStatus();
    const profiles = chrome?.profile && (!wsUrl || wsUrl === chrome.wsUrl) ? [path.join(chrome.profile, 'Default')] : [];
    const icons = await cachedFavicons(tabs.map(tab => tab.url), profiles);
    return tabs.map(tab => ({ ...tab, favicon: icons.get(tab.url) }));
  } finally { cdp.close(); }
}

// Read only the selected target. Other tabs may hold different session storage,
// even when they have the same URL and share cookies.
export async function captureManagedTab(tabId, url, { includeStorage = true, metadataOnly = false, wsUrl = undefined as string | undefined, selectedCookieKeys = undefined as string[] | undefined } = {}) {
  const chrome = wsUrl ? await browserEndpoint(wsUrl) : await chromeStatus();
  if (!chrome) throw new Error('Open the Abra browser, sign in to your site, then refresh tabs.');
  const adapter = await browserAdapterDirectory();
  const { captureTarget } = await import(pathToFileURL(path.join(adapter, 'lib/index.js')).href);
  try { return await captureTarget(chrome.wsUrl, tabId, url, { includeStorage, metadataOnly, selectedCookieKeys }); }
  catch (error) {
    if (error.message === 'selected target changed before capture') throw new Error('The selected tab changed. Refresh tabs and select it again.');
    if (error.message === 'selected target navigated during capture') throw new Error('The selected tab navigated during capture. Refresh tabs and try again.');
    throw error;
  }
}
