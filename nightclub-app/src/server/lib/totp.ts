// RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30s step) + base32 secret handling.
// Minimal self-contained implementation — no external dependency.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function totpSecret(len = 20): string {
  const b = randomBytes(len);
  let out = '';
  for (const byte of b) out += B32[byte % 32];
  return out;
}

function b32decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  const bits: number[] = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('invalid base32');
    for (let i = 4; i >= 0; i--) bits.push((v >> i) & 1);
  }
  const out = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i * 8 + j]!;
    out[i] = byte;
  }
  return out;
}

function hotp(secret: string, counter: number, digits = 6): string {
  const key = b32decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const code = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

export function totpAt(secret: string, atMs: number, stepSec = 30): string {
  return hotp(secret, Math.floor(atMs / 1000 / stepSec));
}

// Verify a user-entered code; ±1 step window for clock skew. Constant-time
// comparison of the (short) candidate strings.
export function totpVerify(
  secret: string, code: string, atMs = Date.now(), stepSec = 30,
): boolean {
  if (!/^[0-9]{6}$/.test(code)) return false;
  const counter = Math.floor(atMs / 1000 / stepSec);
  for (const w of [-1, 0, 1]) {
    const expected = hotp(secret, counter + w);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return true;
  }
  return false;
}

export function otpauthUrl(
  secret: string, account: string, issuer = 'Clubble',
): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
