import { closeSync, openSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths } from './paths.js';
import { browserCandidates, browserEndpoint, desktopEnvironment } from './browser-discovery.js';
import { executableOnPath, exists, isProcessAlive, processIdentity, readJson, secureDir, sleep, writeJson } from './util.js';

async function chromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null,
    await executableOnPath('google-chrome'),
    await executableOnPath('google-chrome-stable'),
    await executableOnPath('chromium')
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error('Google Chrome was not found. Set CHROME_BIN');
}

async function endpoint(port) {
  return (await browserEndpoint(`http://127.0.0.1:${port}`)).wsUrl;
}

function proxyOption(value) {
  if (!value) return null;
  let proxy;
  try { proxy = new URL(String(value)); }
  catch { throw new Error('browser proxy must be a valid URL'); }
  if (!['http:', 'https:', 'socks:', 'socks5:'].includes(proxy.protocol) || proxy.username || proxy.password) {
    throw new Error('browser proxy must be an HTTP or SOCKS URL without credentials');
  }
  return proxy.href.replace(/\/$/, '');
}

export async function chromeStatus() {
  const state = await readJson(paths().chromeState, null);
  if (state?.owned === false) {
    try { await browserEndpoint(state.wsUrl); return state; }
    catch { return null; }
  }
  if (!state || !await isProcessAlive(state.pid)) return null;
  const identity = await processIdentity(state.pid);
  if (!identity || !state.started_at || identity.started_at !== state.started_at || !identity.command.includes(`--user-data-dir=${paths().chromeProfile}`)) return null;
  try { return { ...state, wsUrl: await endpoint(state.port) }; }
  catch { return null; }
}

export function browserMode(flags: Record<string, unknown>) {
  if (flags.headed === true && flags.headless === true) throw new Error('choose either --headless or --headed');
  return flags.headed === true ? false : flags.headless === true ? true : undefined;
}

export function matchesBrowser(handoff, chrome) {
  return chrome && (handoff.chrome_ws_url ? handoff.chrome_ws_url === chrome.wsUrl : chrome.owned !== false && handoff.chrome_pid === chrome.pid);
}

export async function ensureChrome({ headless, proxy, reuse = true }: { headless?: boolean; proxy?: unknown; reuse?: boolean } = {}) {
  const requestedProxy = proxyOption(proxy);
  const current = await chromeStatus();
  if (current) {
    if (requestedProxy && current.proxy !== requestedProxy) throw new Error('close the managed Chrome window before changing its network route');
    return { ...current, started: false };
  }
  const sandboxAgent = await exists(path.join(paths().home, 'agent.json'));
  const configured = process.env.ABRA_TELEPORT_CDP_URL;
  if (reuse && headless === undefined && !requestedProxy && (sandboxAgent || configured)) {
    for (const candidate of configured ? [configured] : await browserCandidates()) {
      try {
        const browser = await browserEndpoint(candidate);
        const state = { ...browser, owned: false, pid: null, proxy: null };
        await writeJson(paths().chromeState, state);
        return { ...state, started: false };
      } catch (error) { if (configured) throw new Error(`Cannot use the configured sandbox browser: ${error.message}`); }
    }
  }
  const desktop = await desktopEnvironment();
  headless ??= !desktop.available;
  await secureDir(paths().home);
  await secureDir(paths().chromeProfile);
  await rm(path.join(paths().chromeProfile, 'DevToolsActivePort'), { force: true });
  const binary = await chromeBinary();
  const logPath = path.join(paths().home, 'chrome.log');
  const log = openSync(logPath, 'a', 0o600);
  const args = [
    `--user-data-dir=${paths().chromeProfile}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    ...(requestedProxy ? [`--proxy-server=${requestedProxy}`, '--disable-quic'] : []),
    ...(headless ? ['--headless=new'] : []),
    ...(!headless ? ['--window-position=0,0', '--window-size=1440,900'] : []),
    ...(!headless && !desktop.env.DISPLAY && desktop.env.WAYLAND_DISPLAY ? ['--ozone-platform=wayland'] : []),
    ...(process.getuid?.() === 0 || (process.platform === 'linux' && sandboxAgent) ? ['--no-sandbox'] : []),
    ...(process.platform === 'linux' ? ['--disable-dev-shm-usage'] : []),
    'about:blank'
  ];
  const child = spawn(binary, args, { detached: true, stdio: ['ignore', log, log], env: { ...process.env, ...desktop.env } });
  child.unref();
  closeSync(log);
  let port;
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      port = Number((await readFile(path.join(paths().chromeProfile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      if (port) break;
    } catch { /* Chrome is still starting. */ }
    if (!await isProcessAlive(child.pid)) break;
    await sleep(50);
  }
  if (!port) throw new Error(`Chrome did not expose a debugging port. See ${logPath}`);
  const identity = await processIdentity(child.pid);
  if (!identity) throw new Error('Chrome exited before startup.');
  const state = { owned: true, pid: child.pid, binary, port, profile: paths().chromeProfile, headless, proxy: requestedProxy, started_at: identity.started_at, wsUrl: await endpoint(port) };
  await writeJson(paths().chromeState, state);
  return { ...state, started: true };
}

export async function stopChrome() {
  const state = await readJson(paths().chromeState, null);
  if (state?.owned === false) {
    await rm(paths().chromeState, { force: true });
    return { stopped: false, detached: true };
  }
  if (!state || !await isProcessAlive(state.pid)) return { stopped: false };
  const identity = await processIdentity(state.pid);
  if (!identity || !state.started_at || identity.started_at !== state.started_at || !identity.command.includes(`--user-data-dir=${paths().chromeProfile}`)) throw new Error(`refusing to stop PID ${state.pid}; profile marker does not match`);
  process.kill(state.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 100 && await isProcessAlive(state.pid); attempt++) await sleep(50);
  return { stopped: !await isProcessAlive(state.pid) };
}
