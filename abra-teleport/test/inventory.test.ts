import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sandboxCommand } from '../build/src/sandbox.js';

const root = path.resolve(import.meta.dirname, '..');

const ITEMS = [
  { id: `managed:${'a'.repeat(32)}`, kind: 'dev.abra.browser.session.v1', label: 'Example', detail: 'https://example.com/page',
    source: { type: 'cdp', cdp_url: 'ws://127.0.0.1:9222/devtools/browser/x', target_id: 'a'.repeat(32), expected_url: 'https://example.com/page' },
    options: {}, transferable: true },
  { id: 'chrome:42', kind: 'dev.abra.browser.session.v1', label: 'Local only', detail: 'https://local.example/',
    source: { type: 'local-tab', tab_id: '42' }, options: {}, transferable: false }
];

const agent = { id: 'a'.repeat(64), peer_id: 'a'.repeat(64), capsule_id: 'b'.repeat(64), name: 'sandbox', platform: 'linux' };

async function sandboxHome(run: (argv: string[]) => Promise<string>) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'abra-inventory-'));
  const previous = process.env.ABRA_TELEPORT_HOME;
  process.env.ABRA_TELEPORT_HOME = home;
  const restore = async () => {
    if (previous === undefined) delete process.env.ABRA_TELEPORT_HOME; else process.env.ABRA_TELEPORT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  };
  return { home, restore, request: async (_config, argv: string[]) => run(argv) };
}

test('the inventory command asks abra for the browser-session adapter report', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'abra-inventory-cli-'));
  const home = path.join(directory, 'home'), adapter = path.join(directory, 'adapter');
  const binary = path.join(directory, 'abra'), calls = path.join(directory, 'calls');
  try {
    await mkdir(adapter, { recursive: true });
    await writeFile(path.join(adapter, 'abra-adapter.json'), JSON.stringify({ name: 'dev.abra.browser-session' }));
    await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2).filter(value => value !== '--json');
const command = args.slice(2).join(' ');
fs.appendFileSync(process.env.ABRA_FAKE_CALLS, command + '\\n');
if (command === 'status') console.log(JSON.stringify({ peer_id: 'c'.repeat(64) }));
else if (command === 'adapters list') console.log(JSON.stringify({ adapters: [
  { manifest: { name: 'dev.abra.teleport-agent' } }, { manifest: { name: 'dev.abra.browser-session' } }], errors: [] }));
else if (command === 'inventory --adapter dev.abra.browser-session') console.log(JSON.stringify({
  adapter: 'dev.abra.browser-session', label: 'Browser tabs', items: ${JSON.stringify(ITEMS)} }));
else console.log('{}');
`);
    await chmod(binary, 0o755);
    const report = await new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'build/bin/abra-teleport.js'), 'inventory'], {
        env: { ...process.env, ABRA_BIN: binary, ABRA_FAKE_CALLS: calls, ABRA_TELEPORT_HOME: home,
          ABRA_TELEPORT_ABRA_ROOT: path.join(home, 'abra'), ABRA_BROWSER_ADAPTER: adapter },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr.trim())));
    });
    assert.equal(report.adapter, 'dev.abra.browser-session');
    assert.deepEqual(report.items.map(item => item.id), ITEMS.map(item => item.id));
    assert.ok((await readFile(calls, 'utf8')).includes('inventory --adapter dev.abra.browser-session'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('sandbox tabs come from the adapter inventory and keep each source', async () => {
  const sent: string[][] = [];
  const fixture = await sandboxHome(async argv => {
    sent.push(argv);
    return JSON.stringify({ adapter: 'dev.abra.browser-session', label: 'Browser tabs', items: ITEMS });
  });
  try {
    const { tabs } = await sandboxCommand('browser-tabs', agent as any, {}, fixture.request) as any;
    assert.deepEqual(sent, [['inventory']]);
    assert.equal(tabs.length, 1);
    assert.deepEqual(tabs[0], { id: ITEMS[0].id, title: 'Example', url: 'https://example.com/page',
      host: 'example.com', source: ITEMS[0].source });
  } finally { await fixture.restore(); }
});

test('an agent without the inventory command still lists its tabs', async () => {
  const sent: string[][] = [];
  const fixture = await sandboxHome(async argv => {
    sent.push(argv);
    if (argv[0] === 'inventory') throw new Error('This command is not exposed by Teleport.');
    return JSON.stringify([{ id: 'd'.repeat(32), title: 'Old', url: 'https://old.example/', host: 'old.example', source: 'ws://127.0.0.1:9222/x' }]);
  });
  try {
    const { tabs } = await sandboxCommand('browser-tabs', agent as any, {}, fixture.request) as any;
    assert.deepEqual(sent, [['inventory'], ['browser', 'available-tabs']]);
    assert.deepEqual(tabs, [{ id: 'd'.repeat(32), title: 'Old', url: 'https://old.example/', host: 'old.example', source: null }]);
  } finally { await fixture.restore(); }
});

test('inventory failures that are not a missing command are reported', async () => {
  const fixture = await sandboxHome(async () => { throw new Error('transport: timed out'); });
  try {
    await assert.rejects(sandboxCommand('browser-tabs', agent as any, {}, fixture.request), /timed out/);
  } finally { await fixture.restore(); }
});

test('pulling a tab forwards inventory ids and refuses anything else', async () => {
  const sent: string[][] = [];
  const fixture = await sandboxHome(async argv => {
    sent.push(argv);
    return JSON.stringify({ snapshot_id: 'not-a-snapshot' });
  });
  try {
    for (const id of [`managed:${'a'.repeat(32)}`, 'chrome:42', 'e'.repeat(32)]) {
      await assert.rejects(sandboxCommand('browser-pull', agent as any, { tab_id: id }, fixture.request), /Invalid incoming browser handoff/);
    }
    assert.deepEqual(sent.map(argv => argv[2]), [`managed:${'a'.repeat(32)}`, 'chrome:42', 'e'.repeat(32)]);
    for (const id of ['managed:../escape', 'chrome:$(whoami)', 'managed:zz', '', 'managed:' + 'a'.repeat(31)]) {
      await assert.rejects(sandboxCommand('browser-pull', agent as any, { tab_id: id }, fixture.request), /Choose a sandbox tab/);
    }
  } finally { await fixture.restore(); }
});
