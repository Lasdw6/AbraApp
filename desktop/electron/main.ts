import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification } from 'electron';
import electronUpdater from 'electron-updater';
import { copyFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createConnections } from './connections.js';
import { createTeleport } from './teleport.js';
import { createIncomingMonitor, type IncomingHandoff } from './incoming.js';

export const PROTOCOL = 'abra-teleport';

// A second launch must reuse the running app: the daemon, its named pipe, and
// the managed Chrome profile can only be owned by one process at a time.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

function runtime() {
  if (app.isPackaged) {
    const root = path.join(process.resourcesPath, 'Runtime');
    return {
      wrapper: path.join(root, 'wrapper'),
      abra: path.join(root, process.platform === 'win32' ? 'abra.exe' : 'abra'),
      adapter: path.join(root, 'browser-session'),
      observer: path.join(root, 'observer.py'),
      node: process.platform === 'linux' ? path.join(root, 'node/bin/node') : process.execPath,
      asNode: process.platform !== 'linux',
    };
  }
  return {
    wrapper: path.resolve(__dirname, '../../../abra-teleport/build'),
    abra: path.resolve(__dirname, '../../../abra/target/debug', process.platform === 'win32' ? 'abra.exe' : 'abra'),
    adapter: path.resolve(__dirname, '../../../abra/adapters/browser-session'),
    observer: path.resolve(__dirname, '../../../abra/adapters/sandbox/collector/observer.py'),
    node: process.execPath,
    asNode: true,
  };
}

const teleport = createTeleport(runtime());
const connections = createConnections({ home: app.getPath('home'), teleport });
const notifications = new Set<Notification>();
function showApp() {
  let window = BrowserWindow.getAllWindows()[0];
  if (!window) { createWindow(); window = BrowserWindow.getAllWindows()[0]; }
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}
function notifyIncoming(items: IncomingHandoff[]) {
  const groups = new Map<string, IncomingHandoff[]>();
  for (const item of items) groups.set(item.agent_id, [...(groups.get(item.agent_id) || []), item]);
  for (const group of groups.values()) {
    const text = `${group[0].agent_name} sent ${group.length === 1 ? 'a tab' : `${group.length} tabs`}.`;
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('abra:incoming', text);
    if (!Notification.isSupported()) continue;
    const notification = new Notification({ title: 'Abra', body: `${text} Open Sandbox tabs to view.`,
      icon: path.join(__dirname, '../..', 'dist-web', 'icon.png') });
    notifications.add(notification);
    notification.on('click', showApp);
    notification.on('close', () => notifications.delete(notification));
    notification.on('failed', (_event, error) => { notifications.delete(notification); console.error('Abra notification failed:', error); });
    notification.show();
  }
}
const incoming = createIncomingMonitor({
  file: path.join(process.env.ABRA_TELEPORT_HOME || path.join(app.getPath('home'), '.abra-teleport'), 'notified-handoffs.json'),
  read: () => connections.incoming(), notify: notifyIncoming,
});
let incomingTimer: ReturnType<typeof setInterval> | undefined;
ipcMain.handle('abra:provider-config', () => connections.config());
ipcMain.handle('abra:agent-ticket', () => connections.ticket());
ipcMain.handle('abra:export-installer', async () => {
  const result = await dialog.showSaveDialog({ title: 'Save agent CLI installer', defaultPath: 'abra-teleport-agent.tar.gz' });
  if (result.canceled || !result.filePath) return null;
  const source = app.isPackaged ? path.join(process.resourcesPath, 'abra-teleport-agent.tar.gz')
    : path.resolve(__dirname, '../../../abra-teleport/dist/abra-teleport-agent.tar.gz');
  await copyFile(source, result.filePath);
  return result.filePath;
});
ipcMain.handle('abra:connection-health', () => connections.health());
ipcMain.handle('abra:agent-list', () => connections.list());
ipcMain.handle('abra:agent-select', (_event, id) => connections.select(id));
ipcMain.handle('abra:agent-rename', (_event, id, name) => connections.rename(id, name));
ipcMain.handle('abra:agent-remove', (_event, id) => connections.remove(id));
ipcMain.handle('abra:sandbox', (_event, action, payload, agentId) => connections.command(action, payload, agentId));

async function local(args: string[]) {
  return teleport.raw(args);
}

ipcMain.handle('abra:local', (_event, args) => local(args));

// Matches --bg, --fg, and the 44px `.bar` in desktop/src/styles.css.
function titleBarOverlay() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? '#171717' : '#ffffff', symbolColor: dark ? '#e6e6e6' : '#1c1c1e', height: 44 };
}

/** Accepts an `abra-teleport://` deep link, such as a pairing ticket. */
export function deepLink(argv: string[]) {
  return argv.find(value => value.startsWith(`${PROTOCOL}://`)) || null;
}

function handleDeepLink(url: string | null) {
  showApp();
  // The app issues pairing tickets rather than accepting them, so there is no
  // pairing entry point to route this into yet. Focus the window and record it.
  if (url) console.log(`Abra received a deep link: ${url}`);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 640,
    minHeight: 420,
    title: 'Abra Teleport',
    icon: path.join(__dirname, '../..', 'dist-web', 'icon.png'),
    // The renderer draws its own title bar (`.bar`, a drag region), so Windows
    // only needs to overlay its window controls on top of it.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : process.platform === 'win32' ? 'hidden' : 'default',
    ...(process.platform === 'win32' ? { titleBarOverlay: titleBarOverlay() } : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171717' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.loadFile(path.join(__dirname, '../..', 'dist-web', 'index.html'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (process.platform === 'win32') {
    const paint = () => { try { window.setTitleBarOverlay(titleBarOverlay()); } catch { /* Window closed. */ } };
    nativeTheme.on('updated', paint);
    window.once('closed', () => nativeTheme.removeListener('updated', paint));
  }
}

app.on('second-instance', (_event, argv) => handleDeepLink(deepLink(argv)));
app.on('open-url', (event, url) => { event.preventDefault(); handleDeepLink(url); });

if (primary) app.whenReady().then(() => {
  app.setName('Abra Teleport');
  // In development Electron is launched with a script path, which the registry
  // entry has to repeat for Windows to hand the link back to the same app.
  if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
  else app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1] ?? '.')]);
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, '../..', 'dist-web', 'icon.png'));
  if (process.platform === 'win32') app.setAppUserModelId('dev.abra.teleport');
  createWindow();
  const poll = () => { void incoming.poll().catch(error => console.error('Abra inbox check failed:', error.message)); };
  poll(); incomingTimer = setInterval(poll, 5000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  const launchLink = deepLink(process.argv.slice(1));
  if (launchLink) handleDeepLink(launchLink);
  if (app.isPackaged) {
    electronUpdater.autoUpdater.on('error', error => console.error('Abra update check failed:', error.message));
    void electronUpdater.autoUpdater.checkForUpdatesAndNotify().catch(error => console.error('Abra update check failed:', error.message));
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { clearInterval(incomingTimer); incoming.stop(); void teleport.close(); });
