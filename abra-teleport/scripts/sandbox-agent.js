// Browser input runs inside the connected agent's managed browser context.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserAdapterDirectory } from '../src/abra.js';
import { chromeStatus } from '../src/chrome.js';
import { loadState } from '../src/state.js';

export async function handle(request) {
  if (request.action !== 'browser-input') throw new Error('Unsupported browser action.');
  const adapter = await browserAdapterDirectory();
  const modules = name => import(pathToFileURL(path.join(adapter, 'lib', name + '.js')).href);
  const state = await loadState(), chrome = await chromeStatus();
  if (!chrome || !state.browser.active_context_id) throw new Error('No browser session is active.');
  const { CDP, attachPage } = await modules('cdp');
  const cdp = await new CDP(chrome.wsUrl).connect();
  try {
    const page = (await cdp.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page' && t.browserContextId === state.browser.active_context_id && /^https?:/.test(t.url)).at(-1);
    if (!page) throw new Error('No page is open.');
    const session = await attachPage(cdp, page.targetId);
    try {
      if (request.text !== undefined) {
        if (typeof request.text !== 'string' || request.text.length > 10000) throw new Error('Invalid browser input.');
        await cdp.send('Input.insertText', { text: request.text }, session);
      } else if (request.key) {
        if (!['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowDown', 'ArrowUp'].includes(request.key)) throw new Error('Invalid key.');
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: request.key, windowsVirtualKeyCode: { Enter: 13, Tab: 9, Backspace: 8, Escape: 27, ArrowDown: 40, ArrowUp: 38 }[request.key], ...(request.key === 'Enter' ? { text: '\r' } : {}) }, session);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: request.key }, session);
      } else {
        if (![request.x, request.y].every(v => Number.isFinite(v) && v >= 0 && v <= 10000)) throw new Error('Invalid coordinates.');
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: request.x, y: request.y, button: 'left', clickCount: 1 }, session);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: request.x, y: request.y, button: 'left', clickCount: 1 }, session);
      }
    } finally { await cdp.send('Target.detachFromTarget', { sessionId: session }); }
    return { sent: true };
  } finally { cdp.close(); }
}
