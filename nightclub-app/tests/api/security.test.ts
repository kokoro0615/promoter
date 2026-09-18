// Security foundation regression tests (Phase 3b):
//  F-007 runtime schema validation — bad params/body rejected with 400
//  F-008 same-site guard — cross-site/cross-origin mutations rejected
//  F-009 rate limiting — credential endpoints bounded per client IP
//  F-021 baseline security headers on every response
import { describe, it, expect } from 'vitest';
import { getApp, call, seed } from '../helpers.js';

process.env.WORKER_AUTOSTART = '0';

const S = seed();

describe('F-021 security headers', () => {
  it('sets baseline headers on API responses', async () => {
    const r = await call('GET', '/healthz');
    expect(r.status).toBe(200);
    const h = r.res.headers;
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['content-security-policy']).toContain("default-src 'none'");
    expect(h['cache-control']).toBe('no-store');
  });
});

describe('F-007 runtime schema validation', () => {
  it('rejects malformed uuid params with 400', async () => {
    const r = await call('GET', '/stores/not-a-uuid/events/x/visits');
    expect(r.status).toBe(400);
  });

  it('rejects missing required body fields with 400', async () => {
    const r = await call('POST',
      `/stores/${S.store}/events/${S.event}/visits`, {},
      { reception_name: 'x' }); // planned_count + segments missing
    expect(r.status).toBe(400);
  });

  it('rejects wrong-typed fields with 400', async () => {
    const r = await call('POST',
      `/stores/${S.store}/events/${S.event}/visits`, {},
      {
        reception_name: 'x', planned_count: 'four',
        segments: [{ rule_key: 'std', count: 1 }],
      });
    expect(r.status).toBe(400);
  });

  it('rejects out-of-range values with 400', async () => {
    const r = await call('POST',
      `/stores/${S.store}/events/${S.event}/visits`, {},
      {
        reception_name: 'x', planned_count: 0,
        segments: [{ rule_key: 'std', count: 1 }],
      });
    expect(r.status).toBe(400);
  });

  it('rejects bad enum values with 400', async () => {
    const r = await call('POST',
      `/stores/${S.store}/events/${S.event}/ticket-orders`, {},
      {
        product_id: S.store, quantity: 1, buyer_name: 'b',
        method: 'PSP', // not allowed until PSP wired
      });
    expect(r.status).toBe(400);
  });

  it('does not reject undeclared extra fields (stripped by ajv)', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST', url: '/api/auth/dev/login',
      payload: { subject: 'admin', unexpected_junk: 'ignored' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('F-008 same-site guard (CSRF via Fetch Metadata / Origin)', () => {
  const path = `/stores/${S.store}/exports`;
  const url = () => `/api${path}`;

  it('rejects state-changing requests with Sec-Fetch-Site: cross-site', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST', url: url(),
      headers: { 'sec-fetch-site': 'cross-site' },
      payload: { report_kind: 'visits', format: 'CSV' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects mutations whose Origin does not match the Host', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST', url: url(),
      headers: { origin: 'https://evil.example', host: 'localhost:8787' },
      payload: { report_kind: 'visits', format: 'CSV' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows same-origin mutations through the guard', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST', url: url(),
      headers: { 'sec-fetch-site': 'same-origin' },
      payload: { report_kind: 'visits', format: 'CSV' },
    });
    // Guard passed; auth layer responds (unauthenticated -> 401).
    expect(res.statusCode).toBe(401);
  });

  it('allows non-browser clients with no fetch metadata', async () => {
    const r = await call('POST', path, {},
      { report_kind: 'visits', format: 'CSV' });
    expect(r.status).toBe(401); // guard did not block; auth did
  });

  it('does not apply the guard to safe methods', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'GET', url: `/api/stores/${S.store}/exports`,
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('F-009 rate limiting', () => {
  it('throttles repeated credential endpoint hits with 429', async () => {
    const app = await getApp();
    let saw429 = 0;
    for (let i = 0; i < 30; i++) {
      const res = await app.inject({
        method: 'POST', url: '/api/auth/dev/login',
        payload: { subject: 'admin' },
      });
      if (res.statusCode === 429) saw429++;
    }
    expect(saw429).toBeGreaterThan(0);
  });
});
