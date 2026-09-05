import assert from 'node:assert/strict';
import test from 'node:test';
import { redact } from '../build/src/util.js';

test('subprocess error redaction removes tickets, tokens, and URLs', () => {
  const input = `abra-pair/1/secret_ticket sk-${'x'.repeat(32)} https://example.com/private`;
  const output = redact(input);
  assert.doesNotMatch(output, /secret_ticket|sk-|example\.com/);
});
