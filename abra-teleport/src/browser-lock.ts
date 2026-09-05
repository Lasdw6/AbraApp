import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { paths } from './paths.js';
import { secureDir, sleep } from './util.js';

// SQLite's OS lock is released even if a CLI process is killed. This serializes
// agent-initiated sends with commands arriving from the laptop.
export async function withBrowserLock<T>(work: () => Promise<T>): Promise<T> {
  const { DatabaseSync } = await import('node:sqlite');
  await secureDir(paths().home);
  const file = path.join(paths().home, 'browser-operation.sqlite');
  const db = new DatabaseSync(file, { timeout: 0 });
  await chmod(file, 0o600);
  let locked = false;
  try {
    const deadline = Date.now() + 480000;
    while (!locked) {
      try { db.exec('BEGIN EXCLUSIVE'); locked = true; }
      catch (error) {
        if (!/database is locked/.test(error.message) || Date.now() >= deadline) throw error;
        await sleep(50);
      }
    }
    return await work();
  } finally {
    if (locked) db.exec('ROLLBACK');
    db.close();
  }
}
