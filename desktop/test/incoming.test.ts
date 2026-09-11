import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createIncomingMonitor, type IncomingHandoff } from '../electron/incoming';

test('new handoffs notify once across polls and restarts, while an old inbox is quiet', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra incoming '));
  const item = (id: string, time: number, agent_id = 'agent'): IncomingHandoff => ({ id, agent_id, agent_name: agent_id, received_at: new Date(time).toISOString() });
  let items = [item('old', 100)];
  const notifications: IncomingHandoff[][] = [];
  const options = { file: path.join(root, 'seen.json'), read: async () => items,
    notify: (fresh: IncomingHandoff[]) => { notifications.push(fresh); }, startedAt: 200 };
  try {
    const monitor = createIncomingMonitor(options);
    await monitor.poll();
    assert.equal(notifications.length, 0);
    items = [...items, item('new', 300), item('new', 301, 'another-agent')];
    await Promise.all([monitor.poll(), monitor.poll()]);
    assert.deepEqual(notifications.map(batch => batch.map(item => item.agent_id)), [['agent', 'another-agent']]);
    await monitor.poll();
    monitor.stop();
    const restarted = createIncomingMonitor({ ...options, startedAt: 500 });
    await restarted.poll();
    assert.equal(notifications.length, 1);
    items = [...items, item('arrived-while-closed', 400)];
    await restarted.poll();
    assert.equal(notifications[1][0].id, 'arrived-while-closed');
    restarted.stop();
    items = [...items, item('after-quit', 600)];
    await restarted.poll();
    assert.equal(notifications.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a quiet first launch still remembers the inbox for handoffs received while closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abra incoming first launch '));
  let items: IncomingHandoff[] = [];
  const notified: IncomingHandoff[] = [];
  const options = { file: path.join(root, 'seen.json'), read: async () => items,
    notify: (fresh: IncomingHandoff[]) => { notified.push(...fresh); } };
  try {
    const first = createIncomingMonitor({ ...options, startedAt: 100 });
    await first.poll();
    first.stop();
    items = [{ id: 'while-closed', agent_id: 'agent', agent_name: 'Agent', received_at: new Date(200).toISOString() }];
    const restarted = createIncomingMonitor({ ...options, startedAt: 300 });
    await restarted.poll();
    await restarted.poll();
    assert.deepEqual(notified.map(item => item.id), ['while-closed']);
    restarted.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});
