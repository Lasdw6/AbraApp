import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createConnections } from './connections.js';

function runtime() {
  if (app.isPackaged) {
    const root = path.join(process.resourcesPath, 'Runtime');
    return {
      wrapper: path.join(root, 'wrapper'),
      abra: path.join(root, 'abra'),
      adapter: path.join(root, 'browser-session'),
      observer: path.join(root, 'observer.py'),
      node: process.platform === 'linux' ? path.join(root, 'node/bin/node') : process.execPath,
      asNode: process.platform !== 'linux',
    };
  }
  return {
    wrapper: path.resolve(__dirname, '../../../abra-teleport/build'),
    abra: path.resolve(__dirname, '../../../abra/target/debug/abra'),
    adapter: path.resolve(__dirname, '../../../abra/adapters/browser-session'),
    observer: path.resolve(__dirname, '../../../abra/adapters/sandbox/collector/observer.py'),
    node: process.execPath,
    asNode: true,
  };
}

const connections = createConnections({ home: app.getPath('home'), runtime });
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
ipcMain.handle('abra:sandbox', (_event, action, payload) => connections.command(action, payload));

function validateArgs(args: unknown): string[] {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.length > 100000)) {
    throw new Error('Invalid Abra command arguments.');
  }
  return args;
}

function run(executable: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', code => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0) resolve(out);
      else reject(new Error(err || out.trim() || `Abra exited with status ${code}.`));
    });
  });
}

async function local(args: string[]) {
  const paths = runtime();
  const script = path.join(paths.wrapper, 'bin', 'abra-teleport.js');
  return run(paths.node, [script, ...validateArgs(args)], {
    cwd: paths.wrapper,
    env: {
      ...(paths.asNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ABRA_BIN: paths.abra,
      ABRA_BROWSER_ADAPTER: paths.adapter,
      ABRA_TELEPORT_DESKTOP: '1',
      PATH: [path.dirname(paths.node), process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean).join(path.delimiter),
    },
  });
}

ipcMain.handle('abra:local', (_event, args) => local(args));
function createWindow() {
  const window = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1060,
    minHeight: 720,
    title: 'Abra Teleport',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0b0d12',
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
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
