import { describe, expect, it } from 'vitest';
import {
  hashToken, pairingCode, randomToken, sha256, signSnapshot, verifySnapshot,
} from '../../src/server/lib/crypto.js';

describe('crypto helpers', () => {
  it('sha256/hashToken are deterministic hex digests', () => {
    expect(sha256('x')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('x')).toBe(sha256('nc-token:x'));
    expect(hashToken('x')).not.toBe(hashToken('y'));
  });
  it('randomToken is url-safe and unique', () => {
    const a = randomToken(); const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });
  it('pairingCode is 8 chars from the unambiguous alphabet', () => {
    expect(pairingCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  });
  it('snapshot token round-trips and rejects tampering', () => {
    const eventId = crypto.randomUUID();
    const exp = new Date(Date.now() + 60_000);
    const tok = signSnapshot(eventId, '42', exp);
    const v = verifySnapshot(tok, eventId);
    expect(v?.cursor).toBe('42');
    expect(verifySnapshot(tok, crypto.randomUUID())).toBeNull();
    expect(verifySnapshot(`${tok}x`, eventId)).toBeNull();
    const expired = signSnapshot(eventId, '1', new Date(Date.now() - 1000));
    expect(verifySnapshot(expired, eventId)).toBeNull();
  });
});
