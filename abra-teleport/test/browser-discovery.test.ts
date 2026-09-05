import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { browserCandidates, browserEndpoint, desktopEnvironment, localBrowserUrl, waitForBrowser } from '../build/src/browser-discovery.js';
import { browserMode, matchesBrowser } from '../build/src/chrome.js';

test('automatic browser mode uses the sandbox desktop and falls back when absent', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'abra-display-'));
  const socket = net.createServer();
  try {
    assert.equal(browserMode({}), undefined);
    assert.equal(browserMode({ headed: true }), false);
    assert.equal(browserMode({ headless: true }), true);
    assert.throws(() => browserMode({ headed: true, headless: true }));
    assert.equal((await desktopEnvironment({}, 'linux', directory)).available, false);
    assert.equal((await desktopEnvironment({}, 'darwin', directory)).available, true);
    assert.equal((await desktopEnvironment({ DISPLAY: ':5' }, 'linux', directory)).env.DISPLAY, ':5');
    assert.equal((await desktopEnvironment({ WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: directory }, 'linux', directory)).available, true);
    await new Promise<void>(resolve => socket.listen(path.join(directory, 'X1'), resolve));
    assert.equal((await desktopEnvironment({}, 'linux', directory)).env.DISPLAY, ':1');
  } finally {
    if (socket.listening) await new Promise<void>(resolve => socket.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('browser attachment stays local and rejects changed browser identities', async () => {
  for (const url of ['https://example.com', 'http://192.168.1.2:9222', 'http://user:secret@localhost:9222', 'file:///tmp/browser']) assert.throws(() => localBrowserUrl(url));
  let reported = '';
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ Browser: 'Chrome/151', webSocketDebuggerUrl: reported })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as net.AddressInfo;
    const base = `127.0.0.1:${address.port}`;
    reported = `ws://${base}/devtools/browser/original`;
    assert.equal((await browserEndpoint(`http://${base}`)).wsUrl, reported);
    assert.equal(matchesBrowser({ chrome_ws_url: reported }, { wsUrl: reported, owned: false }), true);
    const original = reported;
    reported = `ws://${base}/devtools/browser/restarted`;
    await assert.rejects(browserEndpoint(original), /restarted/);
    assert.equal(matchesBrowser({ chrome_ws_url: original }, { wsUrl: reported, owned: false }), false);
    assert.equal(matchesBrowser({ chrome_pid: null }, { pid: null, owned: false }), false);
    reported = 'ws://example.com/devtools/browser/foreign';
    await assert.rejects(browserEndpoint(`http://${base}`), /local/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});


test('Chrome startup waits for its debugging endpoint and stops when the process exits', async () => {
  let attempts = 0;
  let reported = '';
  const server = http.createServer((_req, res) => {
    if (++attempts < 3) { res.writeHead(503); res.end(); return; }
    res.end(JSON.stringify({ Browser: 'Chrome/151', webSocketDebuggerUrl: reported }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    reported = `ws://${base}/devtools/browser/ready`;
    assert.equal((await waitForBrowser(`http://${base}`, async () => true)).wsUrl, reported);
    await assert.rejects(waitForBrowser(`http://${base}`, async () => false), /Chrome exited/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('discovery selects Chrome on the agent display and ignores other agents and headless processes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-processes-'));
  try {
    for (const [pid, display, port, extra] of [['1', ':4', '9226', ''], ['2', ':5', '9227', ''], ['3', ':4', '9228', '--headless=new'], ['4', ':4', '9229', '--type=renderer']]) {
      const directory = path.join(root, pid);
      await mkdir(directory);
      await writeFile(path.join(directory, 'cmdline'), ['/opt/google/chrome/chrome', `--remote-debugging-port=${port}`, extra].join('\0'));
      await writeFile(path.join(directory, 'environ'), `DISPLAY=${display}\0`);
    }
    // The Chrome launcher changed DISPLAY after starting. Its child retains it.
    await writeFile(path.join(root, '1', 'environ'), '');
    await writeFile(path.join(root, '1', 'cmdline'), ['/bin/bash', '/usr/bin/google-chrome', '--remote-debugging-port=9226'].join('\0'));
    await writeFile(path.join(root, '4', 'status'), 'PPid: 1\n');
    assert.deepEqual(await browserCandidates({ procRoot: root, platform: 'linux', env: { DISPLAY: ':4' } }), ['http://127.0.0.1:9226']);
    await writeFile(path.join(root, '1', 'cmdline'), '/opt/google/chrome/chrome --remote-debugging-port=9226 --user-data-dir=/home/box/chrome-profile-4');
    await mkdir(path.join(root, '5'));
    await writeFile(path.join(root, '5', 'cmdline'), ['bash', '/usr/local/bin/box-bounded-log', '--run', '/tmp/chrome:4.log', '--', 'env', 'DISPLAY=:4', 'nice', '-n', '10', 'google-chrome-stable', '--remote-debugging-port=9226'].join('\0'));
    await writeFile(path.join(root, '5', 'environ'), 'DISPLAY=:4\0');
    await writeFile(path.join(root, '5', 'status'), 'PPid: 1\n');
    assert.deepEqual(await browserCandidates({ procRoot: root, platform: 'linux', env: { DISPLAY: ':4' } }), ['http://127.0.0.1:9226']);

    assert.deepEqual(await browserCandidates({ procRoot: root, platform: 'linux', env: { DISPLAY: ':5' } }), ['http://127.0.0.1:9227']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
