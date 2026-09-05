import { guardCommand } from './disk-guard.js';
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('A build command is required.');
try { await guardCommand(command, args); }
catch (error) { console.error((error as Error).message); process.exitCode = 1; }
