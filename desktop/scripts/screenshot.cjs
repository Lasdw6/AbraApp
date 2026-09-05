// Dev helper: renders dist-web with a fake bridge and saves PNGs.
// Usage: npx vite build && npx electron scripts/screenshot.cjs out.png [pick|selected|editing|list|cloud|multi|offline|unpaired|remote|popover|command]
// Set ABRA_SHOT_LIGHT=1 to render the light theme.
const path = require('node:path');
const fs = require('node:fs');

// Some shells export ELECTRON_RUN_AS_NODE, which makes the electron binary act like plain node.
// In that case relaunch ourselves with the variable cleared.
if (process.env.ELECTRON_RUN_AS_NODE) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, nativeTheme } = require('electron');

const out = process.argv[2] || 'screenshot.png';
const scenario = process.argv[3] || 'pick';
const clickTab = scenario === 'selected' || scenario === 'editing';
const light = Boolean(process.env.ABRA_SHOT_LIGHT);
if (light) nativeTheme.themeSource = 'light';

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 640, show: false, backgroundColor: light ? '#ffffff' : '#171717',
    webPreferences: { preload: path.join(__dirname, 'screenshot-mock.cjs'), contextIsolation: true, sandbox: true, additionalArguments: [`--abra-shot=${scenario}`] },
  });
  await win.loadFile(path.join(__dirname, '..', 'dist-web', 'index.html'));
  await new Promise(r => setTimeout(r, 600));
  const click = async (selector) => {
    await win.webContents.executeJavaScript(`[...document.querySelectorAll(${JSON.stringify(selector)})].at(-1)?.click()`);
    await new Promise(r => setTimeout(r, 500));
  };
  if (clickTab) await click('.tab-card');
  if (scenario === 'editing') await click('.send-summary .link');
  if (scenario === 'list') { await click('.segmented button:first-child'); await click('.row'); }
  if (scenario === 'remote') await click('.remote-toggle');
  if (scenario === 'popover') await click('.agent-pill');
  if (scenario === 'command') { await click('.steps .primary'); await click('.command .actions button:first-child'); }
  const image = await win.webContents.capturePage();
  fs.writeFileSync(out, image.toPNG());
  app.quit();
});
