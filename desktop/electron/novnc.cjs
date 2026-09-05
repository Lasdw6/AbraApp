const http = require('node:http');
const { randomInt } = require('node:crypto');
const { spawn } = require('node:child_process');

let active = null;

function sshBase(target) {
  return [
    '-i', target.ssh_key,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=yes',
  ];
}

function waitForTunnel(child, milliseconds = 900) {
  return new Promise((resolve, reject) => {
    let detail = '';
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    const onData = chunk => { detail = `${detail}${chunk}`.slice(-4000); };
    const onError = error => { clearTimeout(timer); cleanup(); reject(error); };
    const onClose = code => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(detail.trim() || `Remote desktop tunnel exited with status ${code}.`));
    };
    const cleanup = () => {
      child.stderr.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
    };
    child.stderr.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('close', resolve)),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function probe(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/vnc.html', timeout: 1500 }, response => {
      response.resume();
      response.statusCode === 200 ? resolve() : reject(new Error(`noVNC returned HTTP ${response.statusCode}.`));
    });
    request.once('timeout', () => request.destroy(new Error('noVNC did not respond.')));
    request.once('error', reject);
  });
}

async function waitForNoVNC(port) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await probe(port); return; }
    catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  throw lastError || new Error('The sandbox remote desktop is unavailable.');
}

function publicState() {
  const connected = Boolean(active?.tunnel?.exitCode === null);
  return {
    active: connected,
    url: connected ? active.url : null,
  };
}

async function start(target) {
  if (active?.tunnel?.exitCode === null) return publicState();
  await stop();
  let tunnel;
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    const localPort = randomInt(32000, 42000);
    tunnel = spawn('/usr/bin/ssh', [
      ...sshBase(target),
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-N', '-T',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:6080`,
      `${target.ssh_user}@${target.public_ip}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    try {
      await waitForTunnel(tunnel);
      const url = `http://127.0.0.1:${localPort}/vnc.html?autoconnect=1&resize=scale&view_only=0&reconnect=1&reconnect_delay=1000`;
      active = { tunnel, localPort, url };
      tunnel.once('close', () => { if (active?.tunnel === tunnel) active = null; });
      await waitForNoVNC(localPort);
      return publicState();
    } catch (error) {
      lastError = error;
      active = null;
      await terminate(tunnel);
    }
  }
  throw lastError || new Error('Could not open the sandbox remote desktop.');
}

async function stop() {
  const current = active;
  active = null;
  if (current) await terminate(current.tunnel);
  return { active: false, url: null };
}

function status() {
  return publicState();
}

module.exports = { start, stop, status };
