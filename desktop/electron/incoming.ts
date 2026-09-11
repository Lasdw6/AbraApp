import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface IncomingHandoff { id: string; agent_id: string; agent_name: string; received_at: string }

export function createIncomingMonitor({ file, read, notify, startedAt = Date.now() }: {
  file: string;
  read: () => Promise<IncomingHandoff[]>;
  notify: (items: IncomingHandoff[]) => void;
  startedAt?: number;
}) {
  let seen: Set<string> | undefined;
  let pending: Promise<void> | undefined;
  let stopped = false;
  const key = (item: IncomingHandoff) => `${item.agent_id}:${item.id}`;
  async function check() {
    const items = await read();
    if (stopped) return;
    let firstRun = false;
    if (!seen) {
      try { seen = new Set<string>(JSON.parse(await readFile(file, 'utf8'))); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // First install should not announce an entire old inbox.
        seen = new Set(items.filter(item => Date.parse(item.received_at) < startedAt).map(key));
        firstRun = true;
      }
    }
    const fresh = items.filter(item => !seen!.has(key(item)));
    const next = new Set(items.map(key));
    if (firstRun || fresh.length || next.size !== seen.size || [...next].some(id => !seen!.has(id))) {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file + '.tmp', JSON.stringify([...next]), { mode: 0o600 });
      await rename(file + '.tmp', file);
    }
    seen = next;
    if (!stopped && fresh.length) notify(fresh);
  }
  return {
    poll() {
      if (stopped) return Promise.resolve();
      pending ??= check().finally(() => { pending = undefined; });
      return pending;
    },
    stop() { stopped = true; },
  };
}
