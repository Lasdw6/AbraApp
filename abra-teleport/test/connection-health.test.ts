import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkConnection } from '../build/src/connection-health.js';

test('health tracks connection loss and recovery, preserves last seen, and isolates agents', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'abra-health-'));
  const previous = process.env.ABRA_TELEPORT_HOME;
  process.env.ABRA_TELEPORT_HOME = home;
  const agent = { id: 'a'.repeat(64), peer_id: 'a'.repeat(64), capsule_id: 'b'.repeat(64), name: 'sandbox', platform: 'linux' };
  try {
    assert.equal((await checkConnection(null)).status, 'unpaired');
    const online = await checkConnection(agent, async (config, argv, timeout) => {
      assert.deepEqual(argv, ['doctor']); assert.equal(timeout, 8000);
      return JSON.stringify({ daemon: { peer_id: config.peer_id } });
    });
    assert.equal(online.status, 'connected'); assert.ok(online.last_seen);
    const fail = async () => { throw new Error('transport: timed out'); };
    const offline = await checkConnection(agent, fail);
    assert.equal(offline.status, 'unreachable'); assert.equal(offline.last_seen, online.last_seen);
    assert.match(offline.error!, /timed out/);
    const other = { ...agent, id: 'c'.repeat(64), peer_id: 'c'.repeat(64) };
    assert.equal((await checkConnection(other, fail)).last_seen, null);
    const wrongPeer = await checkConnection(agent, async () => JSON.stringify({ daemon: { peer_id: other.peer_id } }));
    assert.equal(wrongPeer.status, 'unreachable'); assert.match(wrongPeer.error!, /unexpected identity/);
    const recovered = await checkConnection(agent, async () => JSON.stringify({ daemon: { peer_id: agent.peer_id } }));
    assert.equal(recovered.status, 'connected'); assert.equal(recovered.error, null);
    await assert.rejects(checkConnection({ ...agent, id: '../escape', peer_id: '../escape' }, fail), /Invalid agent/);
  } finally {
    if (previous === undefined) delete process.env.ABRA_TELEPORT_HOME; else process.env.ABRA_TELEPORT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
