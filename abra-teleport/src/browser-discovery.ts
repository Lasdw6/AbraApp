import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export function localBrowserUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'ws:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('Browser debugging must use a local HTTP or WebSocket endpoint without credentials.');
  }
  return url;
}

export async function browserEndpoint(value: string) {
  const url = localBrowserUrl(value);
  const http = new URL('/json/version', url);
  http.protocol = 'http:';
  const response = await fetch(http, { signal: AbortSignal.timeout(1200), redirect: 'error' });
  if (!response.ok) throw new Error(`Chrome CDP returned HTTP ${response.status}`);
  const body = await response.json();
  const ws = localBrowserUrl(body.webSocketDebuggerUrl || '');
  if (ws.protocol !== 'ws:' || ws.host !== url.host || !ws.pathname.startsWith('/devtools/browser/')) throw new Error('Chrome returned a different browser debugging endpoint');
  if (url.protocol === 'ws:' && ws.href !== url.href) throw new Error('The sandbox browser has restarted');
  return { wsUrl: ws.href, headless: String(body.Browser).startsWith('HeadlessChrome/') };
}

export async function browserCandidates({ procRoot = '/proc', platform = process.platform, env = process.env } = {}) {
  const candidates = new Set<string>();
  const desktop = await desktopEnvironment(env, platform);
  // Chromium launchers may set DISPLAY after startup, so /proc/<pid>/environ
  // can omit it even while their child browser processes inherit it.
  if (platform === 'linux') {
    const processes = new Map<string, { argv: string[]; parent?: string; display?: string; wayland?: string }>();
    for (const pid of await readdir(procRoot).catch(() => [] as string[])) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const directory = path.join(procRoot, pid);
        if ((await stat(directory)).uid !== process.getuid?.()) continue;
        const argv = (await readFile(path.join(directory, 'cmdline'), 'utf8')).split('\0');
        const environment = (await readFile(path.join(directory, 'environ'), 'utf8')).split('\0');
        const status = await readFile(path.join(directory, 'status'), 'utf8').catch(() => '');
        processes.set(pid, { argv, parent: status.match(/^PPid:\s*(\d+)/m)?.[1],
          display: environment.find(value => value.startsWith('DISPLAY='))?.slice(8),
          wayland: environment.find(value => value.startsWith('WAYLAND_DISPLAY='))?.slice(16) });
      } catch { /* A process can exit while being inspected. */ }
    }
    const familyDisplay = (pid: string, field: 'display' | 'wayland') => {
      const own = processes.get(pid)?.[field];
      if (own) return own;
      const values = new Set<string>();
      let generation = new Set([pid]);
      for (let depth = 0; depth < 4 && generation.size; depth++) {
        const next = new Set<string>();
        for (const [child, process] of processes) {
          if (!process.parent || !generation.has(process.parent)) continue;
          if (process[field]) values.add(process[field]!);
          next.add(child);
        }
        generation = next;
      }
      const parent = processes.get(processes.get(pid)?.parent || '');
      if (parent?.[field]) values.add(parent[field]!);
      return values.size === 1 ? [...values][0] : undefined;
    };
    for (const [pid, process] of processes) {
      // Wrappers such as env, nice, and log runners can precede the browser.
      // Only parse flags after an exact browser executable, never a log/profile path.
      const browserIndex = process.argv.findIndex(arg => /^(?:chrome|google-chrome(?:-stable|-beta|-unstable)?|chromium(?:-browser)?)$/.test(path.basename(arg)));
      if (browserIndex < 0) continue;
      const argv = process.argv.slice(browserIndex);
      if (argv.some(arg => arg.startsWith('--type='))) continue;
      if (desktop.available && argv.some(arg => arg === '--headless' || arg.startsWith('--headless='))) continue;
      // Several agents can share a Unix user while using separate desktops.
      if (desktop.env.DISPLAY ? familyDisplay(pid, 'display') !== desktop.env.DISPLAY : desktop.env.WAYLAND_DISPLAY ? familyDisplay(pid, 'wayland') !== desktop.env.WAYLAND_DISPLAY : true) continue;
      const flag = (name: string) => argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1) || (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
      const profile = flag('--user-data-dir');
      if (profile && path.basename(profile) === 'chrome-profile') continue;
      const port = Number(flag('--remote-debugging-port'));
      if (port > 0 && port <= 65535) candidates.add(`http://127.0.0.1:${port}`);
      if (profile && path.isAbsolute(profile)) {
        const activePort = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0]);
        if (activePort > 0 && activePort <= 65535) candidates.add(`http://127.0.0.1:${activePort}`);
      }
    }
  }
  return [...candidates];
}

export async function desktopEnvironment(env = process.env, platform = process.platform, socketDirectory = '/tmp/.X11-unix') {
  if (platform !== 'linux') return { available: true, env: {} as NodeJS.ProcessEnv };
  if (env.DISPLAY) return { available: true, env: { DISPLAY: env.DISPLAY } };
  if (env.WAYLAND_DISPLAY && env.XDG_RUNTIME_DIR) return { available: true, env: { WAYLAND_DISPLAY: env.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR } };
  // Agent tools often omit DISPLAY even though their sandbox runs a desktop.
  const sockets = await readdir(socketDirectory).catch(() => [] as string[]);
  const displays: string[] = [];
  for (const name of sockets.filter(name => /^X\d+$/.test(name))) {
    if ((await stat(path.join(socketDirectory, name)).catch(() => null))?.isSocket()) displays.push(`:${name.slice(1)}`);
  }
  if (displays.length === 1) return { available: true, env: { DISPLAY: displays[0] } };
  return { available: false, env: {} as NodeJS.ProcessEnv };
}
