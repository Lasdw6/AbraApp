const dns = require('node:dns').promises;
const http = require('node:http');
const net = require('node:net');
const { randomInt } = require('node:crypto');
const { spawn } = require('node:child_process');

const blocked = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
]) blocked.addSubnet(network, prefix, 'ipv6');

let active = null;

function sshBase(target) {
  return [
    '-i', target.ssh_key,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=yes',
  ];
}

async function publicAddress(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) throw new Error('The device route blocked a local address.');
  const literal = net.isIP(host);
  const addresses = literal ? [{ address: host, family: literal }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error(`The device route could not resolve ${host}.`);
  if (addresses.some(item => blocked.check(item.address, item.family === 6 ? 'ipv6' : 'ipv4'))) {
    throw new Error('The device route blocked a private or local-network address.');
  }
  return addresses[0];
}

function allowedPort(value) {
  const port = Number(value);
  if (![80, 443].includes(port)) throw new Error('The device route only allows web traffic on ports 80 and 443.');
  return port;
}

function sendSocketError(socket, status, message) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
}

async function startProxy() {
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url);
      if (url.protocol !== 'http:' || url.username || url.password) throw new Error('Only ordinary HTTP destinations are allowed.');
      const port = allowedPort(url.port || 80);
      const resolved = await publicAddress(url.hostname);
      const headers = { ...request.headers, host: url.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const upstream = http.request({
        host: resolved.address,
        family: resolved.family,
        port,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
      }, upstreamResponse => {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.pipe(upstream);
    } catch (error) {
      response.writeHead(403, { 'content-type': 'text/plain' });
      response.end(error.message);
    }
  });
  server.on('connect', async (request, client, head) => {
    try {
      const target = new URL(`http://${request.url}`);
      if (target.username || target.password) throw new Error('Proxy credentials are not allowed.');
      const port = allowedPort(target.port || 443);
      const resolved = await publicAddress(target.hostname);
      const upstream = net.connect({ host: resolved.address, family: resolved.family, port });
      sockets.add(upstream);
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once('error', () => sendSocketError(client, '502 Bad Gateway', 'The destination could not be reached.'));
      upstream.once('close', () => sockets.delete(upstream));
    } catch (error) {
      sendSocketError(client, '403 Forbidden', error.message);
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => sendSocketError(socket, '400 Bad Request', 'Invalid proxy request.'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    sockets,
    port: server.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function waitForTunnel(child, milliseconds = 900) {
  return new Promise((resolve, reject) => {
    let detail = '';
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    const onData = chunk => { detail = `${detail}${chunk}`.slice(-4000); };
    const onError = error => { clearTimeout(timer); cleanup(); reject(error); };
    const onClose = code => { clearTimeout(timer); cleanup(); reject(new Error(detail.trim() || `SSH tunnel exited with status ${code}.`)); };
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

function runProbe(target, remotePort) {
  return new Promise((resolve, reject) => {
    const command = `/usr/bin/curl --silent --show-error --fail --max-time 8 --proxy http://127.0.0.1:${remotePort} https://example.com/ --output /dev/null`;
    const child = spawn('/usr/bin/ssh', [...sshBase(target), `${target.ssh_user}@${target.public_ip}`, command], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error = `${error}${chunk}`.slice(-4000); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(error.trim() || 'The sandbox could not reach the device route.')));
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

async function start(target) {
  if (active?.tunnel?.exitCode === null) return { active: true, proxyUrl: active.proxyUrl };
  await stop();
  const proxy = await startProxy();
  try {
    let tunnel;
    let remotePort;
    let lastError;
    for (let attempt = 0; attempt < 5; attempt++) {
      remotePort = randomInt(42000, 52000);
      tunnel = spawn('/usr/bin/ssh', [
        ...sshBase(target),
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-N', '-T',
        '-R', `127.0.0.1:${remotePort}:127.0.0.1:${proxy.port}`,
        `${target.ssh_user}@${target.public_ip}`,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      try { await waitForTunnel(tunnel); lastError = null; break; }
      catch (error) { lastError = error; await terminate(tunnel); }
    }
    if (lastError || !tunnel || !remotePort) throw lastError || new Error('Could not open the device route.');
    active = { proxy, tunnel, remotePort, proxyUrl: `http://127.0.0.1:${remotePort}` };
    tunnel.once('close', () => { if (active?.tunnel === tunnel) void stop(); });
    await runProbe(target, remotePort);
    return { active: true, proxyUrl: active.proxyUrl };
  } catch (error) {
    await stop(proxy);
    throw error;
  }
}

async function stop(orphanProxy) {
  const current = active;
  active = null;
  if (current) {
    await terminate(current.tunnel);
    await current.proxy.close();
  } else if (orphanProxy) {
    await orphanProxy.close();
  }
  return { active: false };
}

function status() {
  return { active: Boolean(active?.tunnel?.exitCode === null), proxyUrl: active?.proxyUrl || null };
}

module.exports = { start, stop, status };
