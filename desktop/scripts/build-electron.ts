import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import * as path from 'node:path';

const desktop = path.resolve(__dirname, '..');
rmSync(path.join(desktop, 'build-electron'), { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(desktop, 'tsconfig.electron.json')], { stdio: 'inherit' });
