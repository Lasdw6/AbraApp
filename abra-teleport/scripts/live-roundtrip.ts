#!/usr/bin/env node
// Live test orchestration uses SSH only for fixture setup and assertions.
// Pairing, controls, and browser transfers all use Abra over iroh.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { abra, ensureDaemon, stopDaemon } from '../src/abra.js';
import { agentTicket, listAgents, agentRemote } from '../src/agent.js';
import { browserSend, browserReceive } from '../src/browser.js';
import { checkConnection } from '../src/connection-health.js';
import { sandboxCommand } from '../src/sandbox.js';
import { ensureChrome, stopChrome } from '../src/chrome.js';
import { run, redact } from '../src/util.js';
const { CDP, attachPage, evalValue, waitForLoad } = await import(new URL('../../../abra/adapters/browser-session/lib/cdp.js', import.meta.url).href);
const { capture } = await import(new URL('../../../abra/adapters/browser-session/lib/browser.js', import.meta.url).href);

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const report = { ok: false, provider: config.provider, checks: {} as Record<string, boolean>, errors: [] as string[], transport: 'iroh' };
const root = path.resolve(config.report_dir);
await mkdir(root, { recursive: true, mode: 0o700 });
process.env.ABRA_TELEPORT_HOME = path.join(root, 'local');
process.env.ABRA_TELEPORT_ABRA_ROOT = path.join(root, 'local/abra');
process.env.ABRA_TELEPORT_INSTALL_URL = config.install_url;
delete process.env.ABRA_TELEPORT_TRANSPORT;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const remote = script => new Promise<string>((resolve, reject) => {
  const child = spawn(config.remote[0], [...config.remote.slice(1), 'bash -s'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  const timer = setTimeout(() => child.kill(), 600000);
  child.stdout.on('data', x => out += x); child.stderr.on('data', x => err += x);
  child.once('error', reject);
  child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(redact(err || out || `remote exit ${code}`))); });
  child.stdin.on('error', () => {});
  child.stdin.end(`set -euo pipefail\nexport PATH="$HOME/.local/bin:$PATH"\nexport ABRA_TELEPORT_HOME=/tmp/teleport-live/state\n${script}\n`);
});
const save = () => writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const check = async (name, condition) => { report.checks[name] = Boolean(condition); await save(); assert.ok(condition, name); console.log('PASS', name); };
const page = '<!doctype html><title>Teleport live fixture</title><input autofocus oninput="localStorage.setItem(\'typed\',this.value);document.cookie=\'abra_auth=cloud;path=/\'"><script>localStorage.setItem("loaded","yes")</script>';
const server = http.createServer((_req, res) => { res.writeHead(200, {'content-type':'text/html'}); res.end(page); });
const url = 'http://127.0.0.1:18123/';
try {
  await new Promise<void>((resolve,reject) => { server.once('error',reject);server.listen(18123,'127.0.0.1', () => resolve()); });
  await remote(`mkdir -p /tmp/teleport-live/site\nprintf %s ${quote(page)} > /tmp/teleport-live/site/index.html\ncd /tmp/teleport-live/site\nnohup python3 -m http.server 18123 --bind 127.0.0.1 >/tmp/teleport-live/http.log 2>&1 </dev/null &\necho $! > /tmp/teleport-live/http.pid`);
  const ticket = await agentTicket();
  const connected = await remote(ticket.command);
  await check('one_command_install_and_pair', connected.includes('"connected": true'));
  const agents = await listAgents();
  await check('agent_discovered', agents.length === 1);
  const agent = agents[0];
  const command = async args => JSON.parse(await agentRemote(agent,args));
  const doctor = await command(['doctor']);
  await check('control_runs_inside_guest', doctor.app_home === '/tmp/teleport-live/state' && doctor.daemon.peer_id === agent.peer_id);
  const chrome = await ensureChrome({headless:true});
  const cdp = await new CDP(chrome.wsUrl).connect();
  try {
    const id = (await cdp.send('Target.createTarget',{url:'about:blank'})).targetId;
    const session = await attachPage(cdp,id);
    await cdp.send('Page.navigate',{url},session);await waitForLoad(cdp,session);
    await evalValue(cdp,session,'localStorage.setItem("roundtrip","local")');
    await cdp.send('Storage.setCookies',{cookies:[{name:'abra_auth',value:'local',domain:'127.0.0.1',path:'/',secure:false}]});
  } finally {cdp.close();}
  const sent = await browserSend(agent.peer_id,{domains:'127.0.0.1',headless:true,timeout:120000});
  await command(['browser','receive',sent.snapshot_id]);
  const screenshot = await sandboxCommand('browser-frame', agent);
  await check('browser_preview',screenshot.title==='Teleport live fixture' && screenshot.image.length>1000);
  await writeFile(path.join(root,'browser-preview.jpg'),Buffer.from(screenshot.image,'base64'));
  await command(['browser','input',JSON.stringify({text:'remote typed'})]);
  const back = await command(['browser','down']);
  const imported = await browserReceive(back.snapshot_id,{from:agent.peer_id,allow:'127.0.0.1',headless:true});
  const state = await capture(imported.cdp,{}, {browserContextId:imported.browser_context_id});
  await check('browser_cookie_returned',state.cookies.some(x=>x.name==='abra_auth'&&x.value==='cloud'));
  const storage=state.origins.find(x=>x.origin==='http://127.0.0.1:18123')?.localStorage;
  await check('browser_local_storage_returned',storage?.some(x=>x.name==='typed'&&x.value==='remote typed')&&storage?.some(x=>x.name==='roundtrip'&&x.value==='local'));
  await check('browser_tab_returned',state.tabs.some(x=>x.url===url));
  await command(['browser','revoke']);await command(['browser','close']);
  const health = await checkConnection(agent);
  await check('connection_status', health.status === 'connected' && Boolean(health.last_seen));
  report.ok=true;
} catch(error) {report.ok=false;report.errors.push(redact(error.stack||error));console.error(redact(error.message));process.exitCode=1;}
finally {
  await remote('abra-teleport browser close --force || true\nabra-teleport daemon stop || true\nif test -f /tmp/teleport-live/http.pid; then kill "$(cat /tmp/teleport-live/http.pid)" || true; fi').catch(error=>report.errors.push(redact(error.message)));
  await stopChrome().catch(()=>{});await stopDaemon().catch(()=>{});server.close();await save();
}
