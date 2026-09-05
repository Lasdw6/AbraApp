#!/usr/bin/env node
import { createInterface } from 'node:readline';
import path from 'node:path';
import { handleAgentControl } from '../../../src/agent.js';
import { writeJson } from '../../../src/util.js';

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request;
  try {
    if (line.length > 1024 * 1024) throw new Error('Request is too large.');
    request = JSON.parse(line);
    if (request.protocol !== 'abra-adapter/1') throw new Error('Invalid adapter protocol.');
    let result;
    if (request.verb === 'control') result = { result: await handleAgentControl(request) };
    else if (request.verb === 'export' && request.kind === 'dev.abra.teleport.agent.v1') {
      const descriptor = typeof request.source === 'string' ? JSON.parse(request.source) : request.source;
      await writeJson(path.join(request.staging_dir, 'agent.json'), descriptor);
      result = { payload: descriptor, files_path: request.staging_dir, floor: { title: descriptor.name, summary: 'Teleport agent connection' } };
    } else throw new Error('Unsupported agent operation.');
    console.log(JSON.stringify({ request_id: request.request_id, ok: true, ...result }));
  } catch (error) {
    console.log(JSON.stringify({ request_id: request?.request_id || '', ok: false, error: { code: 'agent_error', message: error.message, retryable: false } }));
  }
}
