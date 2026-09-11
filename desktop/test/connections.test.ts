import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConnections } from '../electron/connections';
import type { TeleportService } from '../electron/teleport';

async function fixture(fail = false) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'abra-desktop-startup-'));
  await mkdir(path.join(home, 'bin'));
  if (fail) await writeFile(path.join(home, 'fail-once'), '1');
  await writeFile(path.join(home, 'bin/abra-teleport.js'), `
const fs = require('node:fs'), path = require('node:path');
const home = path.dirname(__dirname), args = process.argv.slice(2);
fs.appendFileSync(path.join(home, 'calls'), args.join(' ') + '\\n');
if (args[0] === 'setup') {
 setTimeout(() => {
  if(fs.existsSync(path.join(home,'fail-once'))) { fs.unlinkSync(path.join(home,'fail-once')); process.exit(1); }
  fs.writeFileSync(path.join(home,'ready'),'1'); console.log('{}');
 }, 100);
} else {
 if(!fs.existsSync(path.join(home,'ready'))) { console.error('request raced setup'); process.exit(1); }
 if(args[1] === 'list') console.log(JSON.stringify([{id:'first',name:'First'},{id:'second',name:'Second'}]));
 else if(args[0] === 'sandbox') {
   let data=''; process.stdin.on('data', chunk => data+=chunk);
   process.stdin.on('end', () => {
     const request=JSON.parse(data);
     if(request.payload.fail) { console.error('sandbox unavailable'); process.exit(1); }
     console.log(JSON.stringify(request));
   });
 } else console.log('{}');
}
`);
  const teleport: TeleportService = {
    raw: async () => '', close: async () => {},
    run: <T>(args: string[], request?: unknown, timeout = 540000) => new Promise<T>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(home, 'bin/abra-teleport.js'), ...args], { timeout, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => {
        if (code !== 0) return reject(new Error(stderr.trim() || `Agent command exited ${code}.`));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Teleport returned an unreadable response.')); }
      });
      child.stdin.end(request === undefined ? '' : JSON.stringify(request));
    }),
  };
  const connections = createConnections({ home, teleport });
  return { home, connections, teleport, calls: async () => (await readFile(path.join(home, 'calls'), 'utf8')).trim().split('\n') };
}

test('concurrent startup requests share one completed daemon setup', async () => {
  const f = await fixture();
  try {
    await Promise.all([f.connections.list(), f.connections.ticket(), f.connections.list()]);
    const calls = await f.calls();
    assert.equal(calls[0], 'setup');
    assert.equal(calls.filter(call => call === 'setup').length, 1);
    assert.equal(calls.length, 4);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('failed setup can be retried without releasing waiting requests early', async () => {
  const f = await fixture(true);
  try {
    const results = await Promise.allSettled([f.connections.list(), f.connections.ticket()]);
    assert.ok(results.every(result => result.status === 'rejected'));
    assert.deepEqual(await f.calls(), ['setup']);
    await f.connections.list();
    assert.deepEqual(await f.calls(), ['setup', 'setup', 'agent list']);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

// Destination selection and the send share one queue, so the header cannot redirect a handoff.
test('send uses the chosen paired agent and retains it for subsequent status requests', async () => {
  const f = await fixture();
  try {
    await f.connections.select('first');
    const result = await f.connections.command('browser-up', { url: 'https://example.com' }, 'second');
    assert.equal(result.config.id, 'second');
    assert.equal((await f.connections.config())?.id, 'second');
    assert.equal((await f.connections.command('status')).config.id, 'second');
    await assert.rejects(f.connections.command('browser-up', {}, 'unknown'), /has not connected/);
    assert.equal((await f.connections.config())?.id, 'second');
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

// Sandbox tab listing goes through the agent, which reads its adapter inventory.
test('sandbox tab listing is forwarded to the selected agent only', async () => {
  const f = await fixture();
  try {
    await f.connections.select('first');
    const result = await f.connections.command('browser-tabs');
    assert.equal(result.config.id, 'first');
    assert.deepEqual(result.payload, {});
    assert.ok((await f.calls()).includes('sandbox browser-tabs'));
    await assert.rejects(f.connections.command('browser-tabs', {}, 'second'), /Choose a valid agent/);
    assert.equal((await f.connections.config())?.id, 'first');
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('failed sends preserve the current agent and active handoffs prevent switching', async () => {
  const f = await fixture();
  try {
    await f.connections.select('first');
    await assert.rejects(f.connections.command('browser-up', { fail: true }, 'second'), /sandbox unavailable/);
    assert.equal((await f.connections.config())?.id, 'first');
    await writeFile(path.join(f.home, '.abra-teleport/handoff.json'), JSON.stringify({ agent: 'first', browsers: [{ id: 'session' }] }));
    await assert.rejects(f.connections.command('browser-up', {}, 'second'), /active handoff/);
    assert.equal((await f.connections.config())?.id, 'first');
    assert.equal((await f.connections.command('browser-up', {}, 'first')).config.id, 'first');
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('agent names persist across restarts, discovery, selection, and handoffs', async () => {
  const f = await fixture();
  try {
    await f.connections.select('first');
    const before = await f.connections.config();
    await Promise.all([f.connections.rename('first', '  Research  '), f.connections.rename('second', 'Writing')]);
    assert.deepEqual(await f.connections.config(), { ...before, name: 'Research' });
    assert.deepEqual((await f.connections.list()).map(agent => agent.name), ['Research', 'Writing']);
    const restarted = createConnections({ home: f.home, teleport: f.teleport });
    assert.equal((await restarted.config())?.name, 'Research');
    assert.equal((await restarted.select('second')).name, 'Writing');
    assert.equal((await restarted.command('browser-up', {}, 'first')).config.name, 'Research');
    await writeFile(path.join(f.home, '.abra-teleport/handoff.json'), JSON.stringify({ agent: 'first', browsers: [{ id: 'session' }] }));
    await restarted.rename('first', 'Research team');
    assert.equal((await restarted.config())?.name, 'Research team');
    assert.equal(JSON.parse(await readFile(path.join(f.home, '.abra-teleport/handoff.json'), 'utf8')).agent, 'first');
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('renaming rejects invalid names and unknown agents without changing saved names', async () => {
  const f = await fixture();
  try {
    await f.connections.select('first');
    for (const name of ['', '   ', 'x'.repeat(81), 'line\nbreak', null]) {
      await assert.rejects(f.connections.rename('first', name as string), /1 and 80/);
    }
    await assert.rejects(f.connections.rename('unknown', 'Name'), /has not connected/);
    assert.equal((await f.connections.config())?.name, 'First');
    await f.connections.rename('first', 'Cursor');
    assert.equal((await f.connections.config())?.name, 'Cursor');
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('removal revokes access before clearing the selection and preserves it on failure', async () => {
  const f = await fixture();
  const run = f.teleport.run.bind(f.teleport);
  let fail = true;
  f.teleport.run = async <T>(args: string[], request?: unknown, timeout?: number): Promise<T> => {
    if (args[0] === 'agent' && args[1] === 'remove') {
      assert.equal((await f.connections.config())?.id, 'first');
      if (fail) throw new Error('revocation failed');
    }
    return run<T>(args, request, timeout);
  };
  try {
    await f.connections.select('first');
    await assert.rejects(f.connections.remove('first'), /revocation failed/);
    assert.equal((await f.connections.config())?.id, 'first');
    fail = false;
    await f.connections.remove('second');
    assert.equal((await f.connections.config())?.id, 'first');
    await f.connections.remove('first');
    assert.equal(await f.connections.config(), null);
    await assert.rejects(f.connections.command('status'), /Connect and select/);
    await assert.rejects(f.connections.remove('unknown'), /has not connected/);
  } finally { await rm(f.home, { recursive: true, force: true }); }
});

test('removal waits for selection so a removed agent cannot become selected again', async () => {
  const f = await fixture();
  try {
    const selecting = f.connections.select('first');
    const removing = f.connections.remove('first');
    await Promise.all([selecting, removing]);
    assert.equal(await f.connections.config(), null);
    assert.ok((await f.calls()).includes('agent remove first'));
  } finally { await rm(f.home, { recursive: true, force: true }); }
});
