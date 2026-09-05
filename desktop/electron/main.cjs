const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const { readFile, copyFile } = require('node:fs/promises');
const path = require('node:path');
const appRunner = require('./app-runner.cjs');
const egress = require('./egress.cjs');
const novnc = require('./novnc.cjs');
const { createConnections } = require('./connections.cjs');

function runtime() {
  if (app.isPackaged) {
    const root = path.join(process.resourcesPath, 'Runtime');
    return {
      wrapper: path.join(root, 'wrapper'),
      abra: path.join(root, 'abra'),
      adapter: path.join(root, 'browser-session'),
      observer: path.join(root, 'observer.py'),
      node: process.execPath,
      asNode: true,
    };
  }
  return {
    wrapper: path.resolve(__dirname, '../../abra-teleport'),
    abra: path.resolve(__dirname, '../../abra/target/debug/abra'),
    adapter: path.resolve(__dirname, '../../abra/adapters/browser-session'),
    observer: path.resolve(__dirname, '../../abra/adapters/sandbox/collector/observer.py'),
    node: '/usr/local/bin/node',
    asNode: false,
  };
}

const connections = createConnections({ home: app.getPath('home'), runtime });
ipcMain.handle('abra:provider-config', () => connections.config());
ipcMain.handle('abra:agent-ticket', () => connections.ticket());
ipcMain.handle('abra:export-installer', async () => {
  const result = await dialog.showSaveDialog({ title: 'Save agent CLI installer', defaultPath: 'abra-teleport-agent.tar.gz' });
  if (result.canceled || !result.filePath) return null;
  const source = app.isPackaged ? path.join(process.resourcesPath, 'abra-teleport-agent.tar.gz')
    : path.resolve(__dirname, '../../abra-teleport/dist/abra-teleport-agent.tar.gz');
  await copyFile(source, result.filePath);
  return result.filePath;
});
ipcMain.handle('abra:agent-list', () => connections.list());
ipcMain.handle('abra:agent-select', (_event, id) => connections.select(id));
ipcMain.handle('abra:sandbox', (_event, action, payload) => connections.command(action, payload));

function validateArgs(args) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.length > 100000)) {
    throw new Error('Invalid Abra command arguments.');
  }
  return args;
}

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
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

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function endpoint() {
  const file = path.join(app.getPath('home'), '.abra-teleport', 'cloud', 'endpoint.json');
  return JSON.parse(await readFile(file, 'utf8'));
}

async function local(args) {
  const paths = runtime();
  const script = path.join(paths.wrapper, 'bin', 'abra-teleport.js');
  return run(paths.node, [script, ...validateArgs(args)], {
    cwd: paths.wrapper,
    env: {
      ...(paths.asNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ABRA_BIN: paths.abra,
      ABRA_BROWSER_ADAPTER: paths.adapter,
      PATH: `${path.dirname(paths.node)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`,
    },
  });
}

async function remote(args) {
  const target = await endpoint();
  const command = ['sudo', 'env', 'DISPLAY=:99', 'XDG_RUNTIME_DIR=/run/abra-teleport', 'ABRA_BROWSER_ADAPTER=/var/lib/abra/adapters/browser-session', 'abra-teleport', ...validateArgs(args)]
    .map(quote)
    .join(' ');
  return run('/usr/bin/ssh', [
    '-i', target.ssh_key,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=yes',
    `${target.ssh_user}@${target.public_ip}`,
    command,
  ]);
}

ipcMain.handle('abra:local', (_event, args) => local(args));
ipcMain.handle('abra:remote', (_event, args) => remote(args));
ipcMain.handle('abra:config', () => endpoint());
ipcMain.handle('abra:choose-workspace', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose the workspace to teleport',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('abra:app-target', (_event, name, sessionId) => appRunner.target(app.getPath('home'), name, sessionId));
ipcMain.handle('abra:app-start', (_event, workspace) => appRunner.start(app.getPath('home'), workspace));
ipcMain.handle('abra:app-stop', () => appRunner.stop());
ipcMain.handle('abra:app-status', () => appRunner.status());
ipcMain.handle('abra:app-open', async () => {
  const current = appRunner.status();
  if (!current.active || !current.url) throw new Error('Start the local app first.');
  await shell.openExternal(current.url);
  return current;
});
ipcMain.handle('abra:egress-start', async () => egress.start(await endpoint()));
ipcMain.handle('abra:egress-stop', () => egress.stop());
ipcMain.handle('abra:egress-status', () => egress.status());
ipcMain.handle('abra:novnc-start', async () => novnc.start(await endpoint()));
ipcMain.handle('abra:novnc-stop', () => novnc.stop());
ipcMain.handle('abra:novnc-status', () => novnc.status());
ipcMain.handle('abra:novnc-open', async () => {
  const current = novnc.status();
  if (!current.active || !current.url) throw new Error('Start the sandbox desktop before opening it.');
  if (process.platform === 'darwin') {
    const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--new-window', current.url], {
      detached: true,
      stdio: 'ignore',
    });
    chrome.unref();
  } else {
    await shell.openExternal(current.url);
  }
  return current;
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1060,
    minHeight: 720,
    title: 'Abra Teleport',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.loadFile(path.join(__dirname, '..', 'dist-web', 'index.html'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

app.whenReady().then(() => {
  app.setName('Abra Teleport');
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
let cleanupStarted = false;
app.on('before-quit', event => {
  if (cleanupStarted || (!appRunner.status().active && !egress.status().active && !novnc.status().active)) return;
  event.preventDefault();
  cleanupStarted = true;
  void Promise.allSettled([appRunner.stop(), egress.stop(), novnc.stop()]).finally(() => app.quit());
});
