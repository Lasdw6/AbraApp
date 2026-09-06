import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';

import type { RuntimePaths } from '../shared/contracts.js';

const runtime = workerData as RuntimePaths;
if (runtime.asNode) process.env.ELECTRON_RUN_AS_NODE = '1';
else delete process.env.ELECTRON_RUN_AS_NODE;
Object.assign(process.env, {
  ABRA_BIN: runtime.abra,
  ABRA_BROWSER_ADAPTER: runtime.adapter,
  ABRA_OBSERVER: runtime.observer,
  ABRA_NODE_BIN: runtime.node,
  ABRA_TELEPORT_DESKTOP: '1',
  PATH: [path.dirname(runtime.node), process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean).join(path.delimiter),
});

void import(pathToFileURL(path.join(runtime.wrapper, 'src/cli.js')).href).then(service => {
  parentPort?.on('message', async ({ id, argv, input }: { id: number; argv: string[]; input: string }) => {
    try { parentPort?.postMessage({ id, output: await service.execute(argv, input) }); }
    catch (error) { parentPort?.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
  });
}).catch(error => { throw error; });
