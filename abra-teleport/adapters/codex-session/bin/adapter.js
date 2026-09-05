#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { exportSession, importSession } from '../lib/session.js';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let request;
  try {
    if (Buffer.byteLength(line) > 1024 * 1024) throw coded('invalid_request', 'request exceeds 1 MiB');
    request = JSON.parse(line);
    if (request.protocol !== 'abra-adapter/1' || !/^[0-9a-f]+$/.test(request.request_id || '')) {
      throw coded('invalid_request', 'invalid protocol or request_id');
    }
    if (request.kind !== 'dev.abra.codex.session.v1') throw coded('unsupported_kind', 'expected dev.abra.codex.session.v1');
    const result = request.verb === 'export'
      ? await exportSession(request)
      : request.verb === 'import'
        ? await importSession(request)
        : (() => { throw coded('unsupported_verb', `unsupported verb: ${request.verb}`); })();
    emit({ request_id: request.request_id, ok: true, ...result });
  } catch (error) {
    emit({
      request_id: request?.request_id || '',
      ok: false,
      error: {
        code: error.code || 'internal',
        message: error.code ? error.message : 'Codex session operation failed',
        retryable: false
      }
    });
  }
}

function coded(code, message) { return Object.assign(new Error(message), { code }); }
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
