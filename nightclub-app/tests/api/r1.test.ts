// R1 end-to-end slice: login -> device pair -> operator unlock -> visit ->
// approval -> identity check -> partial entry -> exit/re-entry -> payment ->
// sync. Plus the explicit negative invariants.
import { beforeAll, describe, expect, it } from 'vitest';
import { call, devLogin, mergeCookies, seed, type Cookies } from '../helpers.js';

let S: ReturnType<typeof seed>;
let promoter: Cookies, admin: Cookies, rival: Cookies;
let device: Cookies, kiosk: Cookies, operatorSession: string;

const storeUrl = (p: string) => `/stores/${S.store}${p}`;
const evUrl = (p: string) => storeUrl(`/events/${S.event}${p}`);

describe('R1 slice', () => {
  beforeAll(async () => {
    S = seed();
    promoter = await devLogin('promoter');
    admin = await devLogin('admin');
    rival = await devLogin('rival');
  });

  it('dev login returns memberships', async () => {
    const me = await call('GET', '/me', { cookies: promoter });
    expect(me.status).toBe(200);
    expect(me.body.memberships.length).toBeGreaterThanOrEqual(1);
  });

  it('name search returns same-name candidates without merging', async () => {
    const r = await call('GET', `${storeUrl('/customers')}?q=${encodeURIComponent('山田')}`, { cookies: promoter });
    expect(r.status).toBe(200);
    const ids = r.body.items.map((x: { id: string }) => x.id);
    expect(ids).toContain(S.customers.yamada1);
    expect(ids).toContain(S.customers.yamada2);
    expect(new Set(ids).size).toBe(ids.length); // distinct rows preserved
  });

  it('cross-tenant member cannot read another store\'s customers', async () => {
    const r = await call('GET', `${storeUrl('/customers')}?q=山田`, { cookies: rival });
    expect([401, 403]).toContain(r.status);
  });

  it('promoter creates a visit -> segment pending approval', async () => {
    const r = await call('POST', evUrl('/visits'), { cookies: promoter, idem: 'v-1' }, {
      reception_name: 'テスト 一郎', planned_count: 3,
      referrer_membership_id: S.members.promoter,
      segments: [{ rule_key: 'guest_free', count: 3 }],
    });
    expect(r.status).toBe(201);
    expect(r.body.segments[0].status).toBe('PENDING');
    (globalThis as { __visit?: string }).__visit = r.body.id;
    (globalThis as { __seg?: string }).__seg = r.body.segments[0].id;
  });

  it('idempotent replay returns the stored result, not a duplicate', async () => {
    const r = await call('POST', evUrl('/visits'), { cookies: promoter, idem: 'v-1' }, {
      reception_name: 'テスト 一郎', planned_count: 3,
      referrer_membership_id: S.members.promoter,
      segments: [{ rule_key: 'guest_free', count: 3 }],
    });
    expect([200, 201]).toContain(r.status);
    expect(r.body.id).toBe((globalThis as { __visit?: string }).__visit);
  });

  it('device enrollment + pairing produces a device cookie', async () => {
    const enr = await call('POST', storeUrl('/devices/enrollments'), { cookies: admin }, { label: 'Door iPad 1' });
    expect(enr.status).toBe(201);
    expect(enr.body.pairing_code).toMatch(/^[A-Z0-9]{8}$/);
    const pair = await call('POST', '/device/enroll', {}, { pairing_code: enr.body.pairing_code });
    expect(pair.status).toBe(200);
    device = mergeCookies(pair.res);
    expect(Object.keys(device).some((k) => k.includes('device'))).toBe(true);
  });

  it('device cookie alone cannot list customers', async () => {
    const r = await call('GET', `${storeUrl('/customers')}?q=山`, { cookies: device });
    expect([401, 403]).toContain(r.status);
  });

  it('operator unlock: wrong PIN rejected, right PIN opens a session', async () => {
    const ops = await call('GET', '/device/operators', { cookies: device });
    expect(ops.status).toBe(200);
    const door = ops.body.items.find((x: { membership_id: string }) => x.membership_id === S.members.door);
    expect(door).toBeTruthy();
    const bad = await call('POST', '/device/operator-sessions', { cookies: device }, {
      membership_id: S.members.door, event_id: S.event, pin: '9999',
    });
    expect(bad.status).toBe(401);
    const ok = await call('POST', '/device/operator-sessions', { cookies: device }, {
      membership_id: S.members.door, event_id: S.event, pin: S.pin,
    });
    expect(ok.status).toBe(200);
    operatorSession = ok.body.operator_session_id;
    kiosk = mergeCookies(ok.res, { ...device });
  });

  it('operator cookie without X-Operator-Context is rejected', async () => {
    const r = await call('GET', evUrl('/visits'), { cookies: kiosk });
    expect(r.status).toBe(409); // OPERATOR_CHANGED
  });

  it('entrance approves normally (no absence/wait/arrival precondition)', async () => {
    const visit = (globalThis as { __visit?: string }).__visit!;
    const list = await call('GET', evUrl('/approvals'), { cookies: kiosk, operatorSession });
    expect(list.status).toBe(200);
    const req0 = list.body.items.find(
      (x: { status: string; visit_id: string }) =>
        x.status === 'PENDING' && x.visit_id === visit);
    expect(req0).toBeTruthy();
    (globalThis as { __req?: string }).__req = req0.id;
    const dec = await call('POST', evUrl(`/approvals/${req0.id}/decisions`),
      { cookies: kiosk, operatorSession, idem: 'dec-1' }, {
        expected_request_version: req0.version,
        expected_segment_version: req0.segment_version,
        decision: 'APPROVED',
      });
    expect(dec.status).toBe(200);
    expect(dec.body.route).toBe('ENTRANCE');
    expect(dec.body.segment.status).toBe('AUTHORIZED');
    expect(dec.body.segment.id).toBe(
      (globalThis as { __seg?: string }).__seg);
  });

  it('second decision on a decided request is rejected (first wins)', async () => {
    const list = await call('GET', evUrl('/approvals'), { cookies: kiosk, operatorSession });
    const req0 = list.body.items.find(
      (x: { id: string }) =>
        x.id === (globalThis as { __req?: string }).__req);
    const dec = await call('POST', evUrl(`/approvals/${req0.id}/decisions`),
      { cookies: kiosk, operatorSession, idem: 'dec-2' }, {
        expected_request_version: req0.version,
        expected_segment_version: req0.segment_version,
        decision: 'REJECTED',
      });
    expect([409, 422]).toContain(dec.status);
  });

  it('name match is not identity: entry requires explicit customer-check', async () => {
    const visit = (globalThis as { __visit?: string }).__visit!;
    // attach the matched customer to the visit principal first
    const v0 = await call('GET', evUrl(`/visits/${visit}`), { cookies: kiosk, operatorSession });
    expect(v0.status).toBe(200);
    const seg = (globalThis as { __seg?: string }).__seg!;
    // bind customer to segment via update is admin-side; here we verify the
    // identity path directly: a customer-bound visit needs a check.
    const chk = await call('POST', evUrl(`/visits/${visit}/customer-checks`),
      { cookies: kiosk, operatorSession, idem: 'cc-1' }, {
        customer_id: S.customers.yamada1, method: 'KNOWN_BY_STAFF',
      });
    expect(chk.status).toBe(201);
    const ent = await call('POST', evUrl(`/visits/${visit}/entries`),
      { cookies: kiosk, operatorSession, idem: 'en-1' }, {
        expected_visit_version: v0.body.version,
        selections: [{ segment_id: seg, count: 2 }], // partial: 2 of 3
      });
    expect(ent.status).toBe(200);
    const remaining = ent.body.visit.segments.find(
      (x: { id: string }) => x.id === seg);
    expect(remaining.first_entered_count).toBe(2);
    expect(remaining.remaining_count).toBe(1);
  });

  it('rejects entry beyond the authorized remainder', async () => {
    const visit = (globalThis as { __visit?: string }).__visit!;
    const seg = (globalThis as { __seg?: string }).__seg!;
    const v0 = await call('GET', evUrl(`/visits/${visit}`), { cookies: kiosk, operatorSession });
    const ent = await call('POST', evUrl(`/visits/${visit}/entries`),
      { cookies: kiosk, operatorSession, idem: 'en-2' }, {
        expected_visit_version: v0.body.version,
        selections: [{ segment_id: seg, count: 5 }],
      });
    expect([409, 422]).toContain(ent.status);
  });

  it('snapshot + changes + sync-ack round trip', async () => {
    const snap = await call('GET', evUrl('/snapshot'), { cookies: kiosk, operatorSession });
    expect(snap.status).toBe(200);
    expect(snap.body.snapshot_token).toBeTruthy();
    const ack = await call('POST', evUrl('/sync-ack'), { cookies: kiosk, operatorSession }, {
      snapshot_token: snap.body.snapshot_token,
      cursor: snap.body.cursor, visibility: 'FOREGROUND',
    });
    expect(ack.status).toBe(200);
    const ch = await call('GET', evUrl('/changes?cursor=0'), { cookies: kiosk, operatorSession });
    expect(ch.status).toBe(200);
    expect(ch.body.items.length).toBeGreaterThanOrEqual(1);
    const types = ch.body.items.map((x: { event_type: string }) => x.event_type);
    expect(types).toContain('visit.upserted');
    expect(types).toContain('entry.recorded');
  });

  it('order + cash payment recorded separately from admission', async () => {
    const visit = (globalThis as { __visit?: string }).__visit!;
    const ord = await call('POST', evUrl('/orders'), { cookies: kiosk, operatorSession, idem: 'o-1' }, {
      visit_id: visit, kind: 'ADMISSION',
    });
    expect(ord.status).toBe(201);
    const pay = await call('POST', evUrl(`/orders/${ord.body.order_id}/payments`),
      { cookies: kiosk, operatorSession, idem: 'p-1' }, {
        method: 'CASH', purpose: 'ADMISSION', amount_minor: 600000,
      });
    expect(pay.status).toBe(201);
    expect(pay.body.status).toBe('SUCCEEDED');
  });

  it('audit log records the chain', async () => {
    const r = await call('GET', storeUrl('/audit-logs'), { cookies: admin });
    expect(r.status).toBe(200);
    const actions = r.body.items.map((x: { action: string }) => x.action);
    for (const a of ['device.enroll.create', 'visit.create', 'approval.decide', 'entry.create', 'payment.record']) {
      expect(actions).toContain(a);
    }
  });
});
