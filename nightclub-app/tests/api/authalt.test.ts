// Phase 3d: email-link login alternative, TOTP MFA enrollment, recovery
// codes, session step-up gating on money routes, PSP adapter boundaries.
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { call, devLogin, mergeCookies, seed } from '../helpers.js';
import { totpAt } from '../../src/server/lib/totp.js';
import { config } from '../../src/server/config.js';

const EMAIL = `t${Date.now()}@example.jp`;

describe('email-link login (LINE alternative)', () => {
  it('request for an unbound address is 202 without a token leak', async () => {
    const r = await call('POST', '/auth/email-link/request', {},
      { email: `nobody-${Date.now()}@example.jp` });
    expect(r.status).toBe(202);
    expect(r.body.accepted).toBe(true);
    expect(r.body.dev_token).toBeUndefined();
  });

  it('bind -> request -> redeem creates a session for the same user', async () => {
    const cookies = await devLogin('admin');
    // Step 1: request a bind token for the signed-in user.
    const bind = await call('POST', '/me/email-identity/bind',
      { cookies }, { email: EMAIL });
    expect(bind.status).toBe(202);
    const bindToken = bind.body.dev_token as string;
    expect(bindToken).toBeTruthy();
    // Step 2: confirm via the emailed token.
    const conf = await call('POST', '/me/email-identity/confirm',
      { cookies }, { token: bindToken });
    expect(conf.status).toBe(200);
    expect(conf.body.bound).toBe(EMAIL);
    // Step 3: the login flow now issues a token for that address.
    const req = await call('POST', '/auth/email-link/request', {},
      { email: EMAIL });
    expect(req.status).toBe(202);
    const loginToken = req.body.dev_token as string;
    expect(loginToken).toBeTruthy();
    // Step 4: redeem -> personal session cookie.
    const red = await call('POST', '/auth/email-link/redeem', {},
      { token: loginToken });
    expect(red.status).toBe(200);
    expect(red.body.user_id).toBe(seed().users.admin);
    const c2 = mergeCookies(red.res);
    const me = await call('GET', '/me', { cookies: c2 });
    expect(me.status).toBe(200);
    expect(me.body.user_id).toBe(seed().users.admin);
    // One-time use: replaying the same token fails.
    const replay = await call('POST', '/auth/email-link/redeem', {},
      { token: loginToken });
    expect(replay.status).toBe(422);
  });

  it('rejects an unknown token', async () => {
    const r = await call('POST', '/auth/email-link/redeem', {},
      { token: 'not-a-real-token' });
    expect(r.status).toBe(422);
  });

  it('refuses binding an address owned by another account', async () => {
    const cookies = await devLogin('promoter');
    const r = await call('POST', '/me/email-identity/bind',
      { cookies }, { email: EMAIL });
    expect(r.status).toBe(409);
  });
});

describe('TOTP MFA + step-up', () => {
  it('enrolls, activates with a TOTP code, and issues recovery codes', async () => {
    const cookies = await devLogin('rival'); // rival tenant-B user, isolated
    const m0 = await call('GET', '/me/mfa', { cookies });
    expect(m0.status).toBe(200);
    expect(m0.body.credentials).toEqual([]);
    const begin = await call('POST', '/me/mfa/totp/begin', { cookies });
    expect(begin.status).toBe(200);
    const secret = begin.body.secret as string;
    expect(begin.body.otpauth_url).toContain(`secret=${secret}`);
    // Wrong code is rejected.
    const bad = await call('POST', '/me/mfa/totp/activate',
      { cookies }, { code: '000000' });
    expect(bad.status).toBe(422);
    // Correct code activates; recovery codes come back exactly once.
    const act = await call('POST', '/me/mfa/totp/activate',
      { cookies }, { code: totpAt(secret, Date.now()) });
    expect(act.status).toBe(200);
    expect(act.body.activated).toBe(true);
    expect(act.body.recovery_codes).toHaveLength(10);
    const m1 = await call('GET', '/me/mfa', { cookies });
    expect(m1.body.credentials[0].status).toBe('ACTIVE');
    expect(m1.body.credentials[0].recovery_remaining).toBe(10);
    // Activation marks the enrolling session stepped-up.
    expect(m1.body.stepped_up).toBe(true);
  });

  it('gates money routes until step-up, then allows via TOTP', async () => {
    // Enroll admin on session A.
    const a = await devLogin('admin');
    const begin = await call('POST', '/me/mfa/totp/begin', { cookies: a });
    const secret = begin.body.secret as string;
    await call('POST', '/me/mfa/totp/activate',
      { cookies: a }, { code: totpAt(secret, Date.now()) });
    // Fresh session B has no step_up_at -> money route is gated.
    const b = await devLogin('admin');
    const s = seed();
    const gated = await call(
      'POST',
      `/stores/${s.store}/events/${s.event}/payments/00000000-0000-0000-0000-000000000000/refunds`,
      { cookies: b, idem: `mfa-gate-${Date.now()}` },
      { amount_minor: 1, reason: 'probe' });
    expect(gated.status).toBe(403);
    expect(gated.body.detail).toContain('step-up');
    // Step up with a TOTP code.
    const up = await call('POST', '/me/mfa/step-up',
      { cookies: b }, { code: totpAt(secret, Date.now()) });
    expect(up.status).toBe(200);
    expect(up.body.stepped_up).toBe(true);
    const m = await call('GET', '/me/mfa', { cookies: b });
    expect(m.body.stepped_up).toBe(true);
    // Same command now passes the gate (payment itself does not exist ->
    // the rejection lands on the business layer, not on the auth gate).
    const ungated = await call(
      'POST',
      `/stores/${s.store}/events/${s.event}/payments/00000000-0000-0000-0000-000000000000/refunds`,
      { cookies: b, idem: `mfa-gate2-${Date.now()}` },
      { amount_minor: 1, reason: 'probe' });
    expect(ungated.status).not.toBe(403);
  });

  it('accepts a recovery code once, then rejects its reuse', async () => {
    const a = await devLogin('admin');
    const begin = await call('POST', '/me/mfa/totp/begin', { cookies: a });
    const secret = begin.body.secret as string;
    const act = await call('POST', '/me/mfa/totp/activate',
      { cookies: a }, { code: totpAt(secret, Date.now()) });
    const recovery = act.body.recovery_codes[0] as string;
    const c = await devLogin('admin');
    const ok = await call('POST', '/me/mfa/step-up',
      { cookies: c }, { recovery_code: recovery });
    expect(ok.status).toBe(200);
    const again = await call('POST', '/me/mfa/step-up',
      { cookies: c }, { recovery_code: recovery });
    expect(again.status).toBe(422);
  });

  it('rejects a bogus second factor', async () => {
    const a = await devLogin('admin');
    const r = await call('POST', '/me/mfa/step-up',
      { cookies: a }, { code: '999999' });
    expect(r.status).toBe(422);
  });
});

describe('PSP adapter boundaries', () => {
  it('rejects an unknown provider', async () => {
    const r = await call('POST', '/integrations/nopsp/webhooks', {},
      { provider_reference: 'x', result: 'success', signature: 'x' });
    expect(r.status).toBe(404);
  });

  it('stripe is a config-gated seam: unavailable without credentials', async () => {
    expect(config.psp.stripeSecretKey).toBe('');
    const r = await call('POST', '/integrations/stripe/webhooks', {},
      { provider_reference: 'x', result: 'success', signature: 'x' });
    expect(r.status).toBe(503);
  });

  it('devpsp webhook still verifies the deterministic signature', async () => {
    const bad = await call('POST', '/integrations/devpsp/webhooks', {},
      { provider_reference: 'ref', result: 'success', signature: 'bogus' });
    expect(bad.status).toBe(401);
    const sig = createHmac('sha256', config.snapshotSecret)
      .update('devpsp:unmatched-ref:success').digest('hex');
    const ok = await call('POST', '/integrations/devpsp/webhooks', {},
      { provider_reference: 'unmatched-ref', result: 'success', signature: sig });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ accepted: true, matched: false });
  });
});
