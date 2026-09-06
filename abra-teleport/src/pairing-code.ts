import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const PAIRING_SERVICE_URL = 'https://ttixdhjdv5popav45lhb2zevnm0eyqbr.lambda-url.us-east-1.on.aws/';
export const isPairingCode = (value: string) => /^ABRA-(?:[A-Z2-7]{8}|[A-Za-z0-9_-]{22})$/.test(value);
const digest = (purpose: string, code: string) => createHash('sha256').update(`abra-pairing-v1:${purpose}:${code}`).digest();
const isShortCode = (code: string) => /^ABRA-[A-Z2-7]{8}$/.test(code);
export const pairingCodeId = (code: string) => digest(isShortCode(code) ? 'short-lookup' : 'lookup', code).toString('hex');

function ticketExpiry(ticket: string, now: number) {
  if (typeof ticket !== 'string' || !ticket.startsWith('abra-pair/1/') || ticket.length > 10000) throw new Error('Invalid pairing ticket. Create a new command in Abra.');
  let expiresAt: number;
  try { expiresAt = Math.floor(Date.parse(JSON.parse(Buffer.from(ticket.slice(12), 'base64url').toString('utf8')).expires_at) / 1000); }
  catch { throw new Error('Invalid pairing ticket. Create a new command in Abra.'); }
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 600) throw new Error('Pairing code expired. Create a new command in Abra.');
  return expiresAt;
}

export function sealPairingTicket(ticket: string, now = Math.floor(Date.now() / 1000)) {
  const expiresAt = ticketExpiry(ticket, now);
  const code = `ABRA-${randomBytes(16).toString('base64url')}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', digest('encryption', code), iv);
  const encrypted = Buffer.concat([cipher.update(ticket, 'utf8'), cipher.final()]);
  return { code, id: pairingCodeId(code), ciphertext: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url'), expiresAt };
}

export function openPairingTicket(code: string, ciphertext: string, now = Math.floor(Date.now() / 1000)) {
  if (!isPairingCode(code) || !/^[A-Za-z0-9_-]{40,16000}$/.test(ciphertext)) throw new Error('Invalid pairing code. Copy a new command from Abra.');
  let ticket: string;
  try {
    const raw = Buffer.from(ciphertext, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', digest('encryption', code), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    ticket = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch { throw new Error('Pairing code could not be verified. Create a new command in Abra.'); }
  ticketExpiry(ticket, now);
  return ticket;
}

type Options = { serviceUrl?: string; fetcher?: typeof fetch };
async function exchange(route: string, body: unknown, { serviceUrl = process.env.ABRA_TELEPORT_PAIRING_URL || PAIRING_SERVICE_URL, fetcher = fetch }: Options = {}) {
  const url = new URL(serviceUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Pairing service must use HTTPS.');
  const response = await fetcher(new URL(route, url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (response.status === 410) throw new Error('Pairing code expired or was already used. Create a new command in Abra.');
  if (response.status === 409) throw new CodeCollision();
  if (!response.ok) throw new Error(`Pairing service returned HTTP ${response.status}. Try creating a new command.`);
  return response.json();
}
class CodeCollision extends Error {}
export async function publishPairingTicket(ticket: string, options?: Options) {
  const expiresAt = ticketExpiry(ticket, Math.floor(Date.now() / 1000));
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = 'ABRA-' + [...randomBytes(8)].map(byte => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[byte & 31]).join('');
    try {
      await exchange('/v2/tickets', { id: pairingCodeId(code), ticket, expiresAt }, options);
      return code;
    } catch (error) { if (!(error instanceof CodeCollision)) throw error; }
  }
  throw new Error('Could not create a unique pairing code. Try again.');
}
export async function resolvePairingCode(code: string, options?: Options) {
  if (!isPairingCode(code)) throw new Error('Invalid pairing code. Copy the command from Abra.');
  if (isShortCode(code)) {
    const result = await exchange('/v2/redeem', { id: pairingCodeId(code) }, options);
    ticketExpiry(result.ticket, Math.floor(Date.now() / 1000));
    return result.ticket as string;
  }
  const result = await exchange('/v1/redeem', { id: pairingCodeId(code) }, options);
  return openPairingTicket(code, result.ciphertext);
}
