import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('browser operations serialize across processes and recover after a killed CLI', { timeout: 15000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'abra-browser-lock-'));
  const module = new URL('../build/src/browser-lock.js', import.meta.url).href;
  const children: ReturnType<typeof spawn>[] = [];
  const start = (id: string, duration = 150) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import {withBrowserLock} from ${JSON.stringify(module)};
      import {appendFile} from 'node:fs/promises';
      await withBrowserLock(async()=>{
        await appendFile(process.env.ABRA_TELEPORT_HOME+'/events',${JSON.stringify(id + ':start\n')});
        console.log('locked');
        await new Promise(r=>setTimeout(r,${duration}));
        await appendFile(process.env.ABRA_TELEPORT_HOME+'/events',${JSON.stringify(id + ':end\n')});
      });
    `], { env: { ...process.env, ABRA_TELEPORT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); return child;
  };
  try {
    const first = start('one'); const firstDone = once(first, 'exit');
    await once(first.stdout!, 'data');
    const second = start('two'); const secondDone = once(second, 'exit');
    assert.equal((await firstDone)[0], 0); assert.equal((await secondDone)[0], 0);
    assert.equal(await readFile(path.join(home, 'events'), 'utf8'), 'one:start\none:end\ntwo:start\ntwo:end\n');
    const killed = start('killed', 60000); const killedDone = once(killed, 'exit');
    await once(killed.stdout!, 'data'); killed.kill('SIGKILL'); await killedDone;
    const recovered = start('recovered');
    assert.equal((await once(recovered, 'exit'))[0], 0);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(home, { recursive: true, force: true });
  }
});
