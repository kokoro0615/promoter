// Contract-parity endpoints: segment replace, visit attribution, manual
// order lines, operating templates, coupons, notification templates, imports.
import { beforeAll, describe, expect, it } from 'vitest';
import { call, devLogin, seed, type Cookies } from '../helpers.js';

let S: ReturnType<typeof seed>;
let admin: Cookies, promoter: Cookies, rival: Cookies;

const storeUrl = (p: string) => `/stores/${S.store}${p}`;
const evUrl = (p: string) => storeUrl(`/events/${S.event}${p}`);

describe('contract parity endpoints', () => {
  let visitId = '';
  let visitVersion = 0;

  beforeAll(async () => {
    S = seed();
    admin = await devLogin('admin');
    promoter = await devLogin('promoter');
    rival = await devLogin('rival');
  });

  it('templates: admin registers an operating template', async () => {
    const r = await call('POST', storeUrl('/templates'),
      { cookies: admin, idem: 'par-t1' }, {
        name: 'Weekend ops',
        policy: { schema_version: '4.0.0', currency: 'JPY' },
      });
    expect(r.status).toBe(201);
    expect(r.body.template_id).toBeTruthy();
    expect(r.body.version).toBe(1);
  });

  it('coupons: create, duplicate code rejected, non-member denied', async () => {
    const coupon = {
      code: 'WELCOME10', valid_from: '2026-01-01T00:00:00Z',
      valid_to: '2027-01-01T00:00:00Z', discount_kind: 'PERCENT',
      discount_value: 10, max_uses: 100, rule_keys: ['general'],
    };
    const r = await call('POST', storeUrl('/coupons'),
      { cookies: admin, idem: 'par-c1' }, coupon);
    expect(r.status).toBe(201);
    expect(r.body.coupon_id).toBeTruthy();
    const dup = await call('POST', storeUrl('/coupons'),
      { cookies: admin, idem: 'par-c2' }, coupon);
    expect(dup.status).toBe(409);
    const denied = await call('POST', storeUrl('/coupons'),
      { cookies: rival, idem: 'par-c3' }, coupon);
    expect([401, 403]).toContain(denied.status);
  });

  it('notification-templates: create, same key+locale rejected', async () => {
    const tpl = {
      key: 'booking.confirm', locale: 'ja',
      body: 'ご予約ありがとうございます',
    };
    const r = await call('POST', storeUrl('/notification-templates'),
      { cookies: admin, idem: 'par-n1' }, tpl);
    expect(r.status).toBe(201);
    expect(r.body.notification_template_id).toBeTruthy();
    const dup = await call('POST', storeUrl('/notification-templates'),
      { cookies: admin, idem: 'par-n2' }, tpl);
    expect(dup.status).toBe(409);
  });

  it('imports: registers an uploaded validation job', async () => {
    const r = await call('POST', storeUrl('/imports'),
      { cookies: admin, idem: 'par-i1' }, {
        source_system: 'legacy-pos',
        object_key: 'imports/2026/09/customers.csv',
        mapping: { name: 'display_name', phone: 'phone' },
      });
    expect(r.status).toBe(201);
    expect(r.body.import_job_id).toBeTruthy();
    expect(r.body.status).toBe('UPLOADED');
  });

  it('order lines: add, source_key dedup, currency mismatch rejected', async () => {
    const v = await call('POST', evUrl('/visits'),
      { cookies: promoter, idem: 'par-v1' }, {
        reception_name: 'Parity Taro', planned_count: 1,
        referrer_membership_id: S.members.promoter,
        segments: [{ rule_key: 'general', count: 1 }],
      });
    expect(v.status).toBe(201);
    visitId = v.body.id as string;
    visitVersion = v.body.version as number;
    const ord = await call('POST', evUrl('/orders'),
      { cookies: admin, idem: 'par-o1' }, {
        visit_id: visitId, kind: 'IN_VENUE',
      });
    expect(ord.status).toBe(201);
    const orderId = ord.body.order_id as string;
    const line = {
      category: 'IN_VENUE', description: 'champagne', quantity: 1,
      gross_minor: 50000, tax_minor: 5000, currency: 'JPY',
      source_key: 'parity-line-1',
    };
    const r = await call('POST', evUrl(`/orders/${orderId}/lines`),
      { cookies: admin, idem: 'par-l1' }, line);
    expect(r.status).toBe(201);
    expect(r.body.line_id).toBeTruthy();
    const dup = await call('POST', evUrl(`/orders/${orderId}/lines`),
      { cookies: admin, idem: 'par-l2' }, line);
    expect(dup.status).toBe(409);
    const bad = await call('POST', evUrl(`/orders/${orderId}/lines`),
      { cookies: admin, idem: 'par-l3' },
      { ...line, source_key: 'parity-line-2', currency: 'USD' });
    expect(bad.status).toBe(422);
    const detail = await call('GET', evUrl(`/orders/${orderId}`),
      { cookies: admin });
    expect(detail.body.lines.some(
      (l: { description: string }) => l.description === 'champagne',
    )).toBe(true);
  });

  it('attribution: reasoned referrer change, stale version rejected', async () => {
    const r = await call('POST', evUrl(`/visits/${visitId}/attribution`),
      { cookies: admin, idem: 'par-a1' }, {
        expected_version: visitVersion,
        referrer_membership_id: S.members.approver,
        reason: 'wrong referrer recorded at reception',
      });
    expect(r.status).toBe(200);
    expect(r.body.visit.referrer_membership_id).toBe(S.members.approver);
    const stale = await call('POST', evUrl(`/visits/${visitId}/attribution`),
      { cookies: admin, idem: 'par-a2' }, {
        expected_version: visitVersion,
        referrer_membership_id: S.members.promoter,
        reason: 'change it back',
      });
    expect(stale.status).toBe(409);
  });

  it('segment replace: pending segment revoked, new rule re-judged', async () => {
    const v = await call('POST', evUrl('/visits'),
      { cookies: promoter, idem: 'par-v2' }, {
        reception_name: 'Replace Jiro', planned_count: 4,
        referrer_membership_id: S.members.promoter,
        segments: [{ rule_key: 'guest_free', count: 3 }],
      });
    expect(v.status).toBe(201);
    const seg = v.body.segments[0] as {
      id: string; version: number; status: string;
    };
    expect(seg.status).toBe('PENDING');
    const r = await call('POST', evUrl(`/segments/${seg.id}/replace`),
      { cookies: admin, idem: 'par-s1' }, {
        expected_version: seg.version, rule_key: 'general',
        count: 2, reason: 'guest rule withdrawn',
      });
    expect(r.status).toBe(201);
    expect(r.body.replaced_segment_id).toBe(seg.id);
    expect(r.body.status).toBe('AUTHORIZED');
    const old = (r.body.visit.segments as { id: string; status: string }[])
      .find((s) => s.id === seg.id);
    expect(old?.status).toBe('REVOKED');
    const stale = await call('POST', evUrl(`/segments/${seg.id}/replace`),
      { cookies: admin, idem: 'par-s2' }, {
        expected_version: seg.version, rule_key: 'general',
        count: 1, reason: 'again',
      });
    expect(stale.status).toBe(409);
  });
});
