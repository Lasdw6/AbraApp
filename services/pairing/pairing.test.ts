import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler, type Store, type Ticket } from './handler.js';
import { openPairingTicket, pairingCodeId, publishPairingTicket, resolvePairingCode, sealPairingTicket } from '../../abra-teleport/build/src/pairing-code.js';

const ticket = (now: number) => 'abra-pair/1/' + Buffer.from(JSON.stringify({ expires_at: new Date((now + 600) * 1000).toISOString(), peer_id: 'fixture', sig: 'signed-ticket-fixture' })).toString('base64url');
function fixture() {
  const entries = new Map<string, Ticket>();
  let limited = false;
  const store: Store = {
    async limit() { return !limited; },
    async put(value) { if (entries.has(value.id)) return false; entries.set(value.id, value); return true; },
    async take(id, now) { const value = entries.get(id); if (!value || value.expiresAt <= now) return null; entries.delete(id); return value; },
  };
  const handler = createHandler(store);
  const requests: string[] = [];
  const fetcher = (async (url: URL, init: RequestInit) => {
    requests.push(String(init.body));
    const result = await handler({ rawPath: url.pathname, body: String(init.body), requestContext: { http: { method: init.method!, sourceIp: '127.0.0.1' } } });
    return new Response(result.body, { status: result.statusCode, headers: result.headers });
  }) as typeof fetch;
  return { entries, requests, fetcher, handler, limit: () => { limited = true; } };
}

test('encrypted tickets round trip and reject changed codes, ciphertext, and expiry', () => {
  const now = Math.floor(Date.now() / 1000), original = ticket(now);
  const sealed = sealPairingTicket(original, now);
  assert.equal(sealed.code.length, 27);
  assert.equal(openPairingTicket(sealed.code, sealed.ciphertext, now), original);
  assert.throws(() => openPairingTicket(sealPairingTicket(original, now).code, sealed.ciphertext, now), /verified/);
  const changed = Buffer.from(sealed.ciphertext, 'base64url'); changed[30] ^= 1;
  assert.throws(() => openPairingTicket(sealed.code, changed.toString('base64url'), now), /verified/);
  assert.throws(() => openPairingTicket(sealed.code, sealed.ciphertext, now + 600), /expired/);
});

test('service never receives the code or plaintext ticket and allows only one redemption', async () => {
  const f = fixture(), original = ticket(Math.floor(Date.now() / 1000));
  const code = await publishPairingTicket(original, { fetcher: f.fetcher, serviceUrl: 'https://pairing.example/' });
  assert.ok(f.entries.has(pairingCodeId(code)));
  const result = await Promise.allSettled([resolvePairingCode(code, { fetcher: f.fetcher, serviceUrl: 'https://pairing.example/' }), resolvePairingCode(code, { fetcher: f.fetcher, serviceUrl: 'https://pairing.example/' })]);
  assert.equal(result.filter(value => value.status === 'fulfilled').length, 1);
  const success = result.find(value => value.status === 'fulfilled');
  assert.equal(success?.value, original);
  assert.equal(f.entries.size, 0);
  assert.ok(f.requests.every(body => !body.includes(code) && !body.includes(original)));
});

test('service rejects invalid expiry, duplicate writes, rate limits, and stale tickets', async () => {
  const f = fixture(), now = Math.floor(Date.now() / 1000), sealed = sealPairingTicket(ticket(now), now);
  const post = (path: string, body: unknown) => f.handler({ rawPath: path, body: JSON.stringify(body), requestContext: { http: { method: 'POST', sourceIp: '127.0.0.1' } } });
  assert.equal((await post('/v1/tickets', { ...sealed, expiresAt: now + 601 })).statusCode, 400);
  assert.equal((await post('/v1/tickets', sealed)).statusCode, 201);
  assert.equal((await post('/v1/tickets', sealed)).statusCode, 409);
  f.entries.set(sealed.id, { ...sealed, expiresAt: now - 1 });
  assert.equal((await post('/v1/redeem', { id: sealed.id })).statusCode, 410);
  f.limit();
  assert.equal((await post('/v1/redeem', { id: sealed.id })).statusCode, 429);
});

test('client rejects non-HTTPS services before publishing credentials', async () => {
  await assert.rejects(publishPairingTicket(ticket(Math.floor(Date.now() / 1000)), { serviceUrl: 'http://example.com' }), /HTTPS/);
});
