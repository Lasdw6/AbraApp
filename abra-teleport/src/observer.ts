import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { appRoot } from './paths.js';
import { exists, run } from './util.js';

export async function observe(workspace) {
  if (process.platform !== 'linux') return null;
  const candidates = [process.env.ABRA_OBSERVER, path.join(appRoot, 'runtime/observer.py'),
    path.resolve(appRoot, '../abra/adapters/sandbox/collector/observer.py'),
    path.resolve(appRoot, '../../abra/adapters/sandbox/collector/observer.py')].filter((value): value is string => typeof value === 'string' && value.length > 0);
  let collector;
  for (const candidate of candidates) if (await exists(candidate)) { collector = candidate; break; }
  if (!collector) throw new Error('The internal observer is missing. Reinstall the Teleport CLI.');
  const barrier = randomBytes(12).toString('hex');
  await run('python3', [collector, '--workspace', workspace, '--all', '--once', '--barrier', barrier], { timeout: 180000 });
  return { barrier, cleanup: () => rm(path.join(workspace, '.abra', `observed-${barrier}.json`), { force: true }) };
}
