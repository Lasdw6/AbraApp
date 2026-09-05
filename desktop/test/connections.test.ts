import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConnections } from '../electron/connections';

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
 console.log(args[1] === 'list' ? '[]' : '{}');
}
`);
  const connections = createConnections({ home, runtime: () => ({ node: process.execPath, wrapper: home, abra: '/unused', adapter: '/unused', observer: '/unused' }) });
  return { home, connections, calls: async () => (await readFile(path.join(home, 'calls'), 'utf8')).trim().split('\n') };
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
