import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron';
import { copyFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createConnections } from './connections.js';
import { createTeleport } from './teleport.js';

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
ipcMain.handle('abra:sandbox', (_event, action, payload, agentId) => connections.command(action, payload, agentId));

async function local(args: string[]) {
  return teleport.raw(args);
}

ipcMain.handle('abra:local', (_event, args) => local(args));
function createWindow() {
  const window = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 640,
    minHeight: 420,
    title: 'Abra Teleport',
    icon: path.join(__dirname, '../..', 'dist-web', 'icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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
}

app.whenReady().then(() => {
  app.setName('Abra Teleport');
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, '../..', 'dist-web', 'icon.png'));
  if (process.platform === 'win32') app.setAppUserModelId('dev.abra.teleport');
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { void teleport.close(); });
