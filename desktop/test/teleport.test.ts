import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTeleport } from '../electron/teleport';

test('worker service preserves output, recovers after timeout, and closes cleanly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra-teleport-worker-'));
  const workerFile = path.join(root, 'worker.cjs');
  await writeFile(workerFile, `
const { parentPort, workerData } = require('node:worker_threads');
parentPort.on('message', async ({ id, argv, input }) => {
  if (argv[0] === 'wait') await new Promise(resolve => setTimeout(resolve, 100));
  parentPort.postMessage({ id, output: JSON.stringify({ argv, input, bin: workerData.abra }) + '\\n' });
});
`);
  const service = createTeleport({ node: process.execPath, wrapper: root, abra: '/runtime/abra',
    adapter: '/runtime/adapter', observer: '/runtime/observer', asNode: false }, 1, workerFile);
  try {
    assert.deepEqual(await service.run(['ok'], { value: 1 }), { argv: ['ok'], input: '{"value":1}', bin: '/runtime/abra' });
    await assert.rejects(service.raw(['wait'], 10), /timed out/);
    assert.deepEqual(await service.run(['again']), { argv: ['again'], input: '', bin: '/runtime/abra' });
    await service.close();
    await assert.rejects(service.raw(['closed']), /service closed/);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
