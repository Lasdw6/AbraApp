import { createHash } from 'node:crypto';

export interface Ticket { id: string; ciphertext?: string; ticket?: string; expiresAt: number }
export interface Store {
  limit(key: string, maximum: number, expiresAt: number): Promise<boolean>;
  put(ticket: Ticket): Promise<boolean>;
  take(id: string, now: number, field: 'ticket' | 'ciphertext'): Promise<Ticket | null>;
}
interface Event {
  rawPath?: string;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string; sourceIp: string } };
}
const response = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: JSON.stringify(body) });

export function createHandler(store: Store, clock = () => Math.floor(Date.now() / 1000)) {
  return async (event: Event) => {
    const route = event.rawPath;
    if (event.requestContext.http.method !== 'POST' || !['/v1/tickets', '/v1/redeem', '/v2/tickets', '/v2/redeem'].includes(route || '')) return response(404, { error: 'Not found' });
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
    if (Buffer.byteLength(raw) > 18000) return response(413, { error: 'Request too large' });
    let body;
    try { body = JSON.parse(raw); } catch { return response(400, { error: 'Invalid request' }); }
    if (!body || typeof body.id !== 'string' || !/^[a-f0-9]{64}$/.test(body.id)) return response(400, { error: 'Invalid request' });
    const now = clock();
    const field = route!.startsWith('/v2/') ? 'ticket' : 'ciphertext';
    const publishing = route!.endsWith('/tickets');
    if (publishing) {
      if (!Number.isInteger(body.expiresAt) || body.expiresAt <= now || body.expiresAt > now + 600) return response(400, { error: 'Invalid ticket or expiry' });
      if (field === 'ciphertext') {
        if (typeof body.ciphertext !== 'string' || !/^[A-Za-z0-9_-]{40,16000}$/.test(body.ciphertext)) return response(400, { error: 'Invalid ticket' });
      } else {
        if (typeof body.ticket !== 'string' || !/^abra-pair\/1\/[A-Za-z0-9_-]+$/.test(body.ticket) || body.ticket.length > 10000) return response(400, { error: 'Invalid ticket' });
        try {
          const expiry = Math.floor(Date.parse(JSON.parse(Buffer.from(body.ticket.slice(12), 'base64url').toString('utf8')).expires_at) / 1000);
          if (expiry !== body.expiresAt) return response(400, { error: 'Invalid ticket expiry' });
        } catch { return response(400, { error: 'Invalid ticket' }); }
      }
    }
    try {
      const minute = Math.floor(now / 60);
      const ip = createHash('sha256').update(event.requestContext.http.sourceIp).digest('hex');
      if (!await store.limit(`rate:${minute}:${ip}`, 30, now + 120) || !await store.limit(`rate:${minute}:all`, 600, now + 120)) return response(429, { error: 'Too many requests. Try again shortly.' });
      if (publishing) {
        const saved = await store.put({ id: body.id, [field]: body[field], expiresAt: body.expiresAt });
        return saved ? response(201, { expiresAt: body.expiresAt }) : response(409, { error: 'Code already exists' });
      }
      const ticket = await store.take(body.id, now, field);
      return ticket ? response(200, { [field]: ticket[field], expiresAt: ticket.expiresAt }) : response(410, { error: 'Pairing code expired or was already used. Create a new command in Abra.' });
    } catch {
      // Never log request bodies, identifiers, IPs, or ticket contents.
      return response(503, { error: 'Pairing service unavailable. Try again shortly.' });
    }
  };
}
