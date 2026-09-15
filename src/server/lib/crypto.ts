import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';

export const uuid = () => randomUUID();
export const randomToken = (bytes = 32) =>
  randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) =>
  createHash('sha256').update(s).digest('hex');

export function hashToken(token: string) {
  return sha256(`nc-token:${token}`);
}

// Pairing code: 8-char human-typable, hash stored server-side.
export function pairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[b[i]! % alphabet.length];
  return s;
}

// Stateless snapshot token binding cursor+expiry to an event.
export function signSnapshot(eventId: string, cursor: string, expiresAt: Date) {
  const body = `${eventId}.${cursor}.${expiresAt.getTime()}`;
  return `${body}.${createHmac('sha256', config.snapshotSecret).update(body).digest('base64url')}`;
}
export function verifySnapshot(token: string, eventId: string) {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [ev, cursor, expMs, sig] = parts;
  const body = `${ev}.${cursor}.${expMs}`;
  const expect = createHmac('sha256', config.snapshotSecret).update(body).digest('base64url');
  if (ev !== eventId || sig !== expect) return null;
  if (Number(expMs) < Date.now()) return null;
  return { cursor };
}

export const canonicalJson = (v: unknown): string =>
  JSON.stringify(sortKeys(v));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}
