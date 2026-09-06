import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const region = process.env.AWS_REGION || 'us-east-1';
const aws = (args: string[]) => execFileSync('aws', [...args, '--region', region], { encoding: 'utf8' });
const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
execFileSync('npm', ['run', 'build:pairing'], { stdio: 'inherit' });
execFileSync('aws', ['cloudformation', 'deploy', '--stack-name', 'abra-pairing', '--template-file', 'services/pairing/stack.json', '--capabilities', 'CAPABILITY_IAM', '--no-fail-on-empty-changeset', '--region', region], { stdio: 'inherit' });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'abra-pairing-deploy-'));
try {
  const archive = path.join(temporary, 'function.zip');
  execFileSync('zip', ['-j', archive, 'services/pairing/dist/index.js'], { stdio: 'ignore' });
  aws(['lambda', 'update-function-code', '--function-name', 'abra-pairing', '--zip-file', `fileb://${archive}`]);
  aws(['lambda', 'wait', 'function-updated', '--function-name', 'abra-pairing']);
  process.stdout.write(aws(['cloudformation', 'describe-stacks', '--stack-name', 'abra-pairing', '--query', 'Stacks[0].Outputs[?OutputKey==`ServiceUrl`].OutputValue | [0]', '--output', 'text']));
} finally { await rm(temporary, { recursive: true, force: true }); }
