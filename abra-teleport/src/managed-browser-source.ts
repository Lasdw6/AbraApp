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
    return (await cdp.send('Target.getTargets')).targetInfos
      .filter(target => target.type === 'page' && /^https?:\/\//.test(target.url))
      .map((target, index) => ({ id: target.targetId, title: target.title, url: target.url,
        host: new URL(target.url).hostname.toLowerCase(), windowIndex: 1, tabIndex: index + 1, active: false }));
  } finally { cdp.close(); }
}

// Read only the selected target. Other tabs may hold different session storage,
// even when they have the same URL and share cookies.
export async function captureManagedTab(tabId, url, { includeStorage = true, metadataOnly = false, wsUrl = undefined as string | undefined } = {}) {
  const expected = new URL(url);
  if (!['http:', 'https:'].includes(expected.protocol)) throw new Error('Select an HTTP or HTTPS tab.');
  const { cdp, attachPage, evalValue } = await connect(wsUrl);
  let session;
  try {
    const { targetInfo } = await cdp.send('Target.getTargetInfo', { targetId: String(tabId || '') });
    if (targetInfo.type !== 'page' || new URL(targetInfo.url).href !== expected.href) {
      throw new Error('The selected tab changed. Refresh tabs and select it again.');
    }
    session = await attachPage(cdp, targetInfo.targetId);
    const tab = await evalValue(cdp, session, `(() => {
      const media = [...document.querySelectorAll('video,audio')].find(item => !item.paused) || document.querySelector('video,audio');
      return { url: location.href, title: document.title,
        scroll: { x: scrollX, y: scrollY, historyLength: history.length },
        media: media ? { currentTime: media.currentTime, paused: media.paused,
          playbackRate: media.playbackRate, volume: media.volume, muted: media.muted } : null };
    })()`);
    const cookies = (await cdp.send('Network.getCookies', { urls: [expected.href] }, session)).cookies;
    const origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }>; sessionStorage: Array<{ name: string; value: string }>; indexedDB: unknown }> = [];
    if (includeStorage && !metadataOnly) {
      const origin = await evalValue(cdp, session, `(() => {
        const entries = storage => Object.keys(storage).sort().map(name => ({ name, value: storage.getItem(name) }));
        return { origin: location.origin, localStorage: entries(localStorage), sessionStorage: entries(sessionStorage) };
      })()`);
      origin.indexedDB = await evalValue(cdp, session, `(async () => {
        const databases = [];
        if (!indexedDB.databases) return { databases };
        for (const info of await indexedDB.databases()) {
          if (!info.name) continue;
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(info.name);
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
          });
          try {
            const stores = [];
            for (const name of db.objectStoreNames) {
              const store = db.transaction(name, 'readonly').objectStore(name), records = [];
              await new Promise((resolve, reject) => {
                const request = store.openCursor();
                request.onsuccess = () => { const cursor = request.result; if (!cursor) return resolve();
                  records.push({ key: cursor.key, value: cursor.value }); cursor.continue(); };
                request.onerror = () => reject(request.error);
              });
              stores.push({ name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, records });
            }
            databases.push({ name: db.name, version: db.version, stores });
          } finally { db.close(); }
        }
        return { databases };
      })()`);
      origins.push(origin);
    }
    const finalURL = await evalValue(cdp, session, 'location.href');
    if (tab.url !== expected.href || finalURL !== expected.href) {
      throw new Error('The selected tab navigated during capture. Refresh tabs and try again.');
    }
    return { cookies: cookies.map(cookie => metadataOnly ? { ...cookie, value: '' } : cookie), origins, tabs: [tab] };
  } finally {
    if (session) await cdp.send('Target.detachFromTarget', { sessionId: session }).catch(() => {});
    cdp.close();
  }
}
