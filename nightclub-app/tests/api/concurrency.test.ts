// Concurrency slice: real parallel races on shared state.
// - two POS orders racing for the last stock unit: exactly one commits
// - same idempotency key fired twice in parallel: never a double effect
// - two decisions racing on one approval request: first decision wins
import { describe, it, expect, beforeAll } from 'vitest';
import { call, devLogin, mergeCookies, seed, type Cookies } from '../helpers.js';

process.env.WORKER_AUTOSTART = '0';

const S = seed();
const storeUrl = (p: string) => `/stores/${S.store}${p}`;
const evUrl = (p: string) => `/stores/${S.store}/events/${S.event}${p}`;

let admin: Cookies, promoter: Cookies, kiosk: Cookies;
let operatorSession: string;

beforeAll(async () => {
  admin = await devLogin('admin');
  promoter = await devLogin('promoter');
  const enr = await call('POST', storeUrl('/devices/enrollments'),
    { cookies: admin }, { label: 'Race iPad' });
  expect(enr.status).toBe(201);
  const pair = await call('POST', '/device/enroll', {},
    { pairing_code: enr.body.pairing_code });
  expect(pair.status).toBe(200);
  const device = mergeCookies(pair.res);
  const ok = await call('POST', '/device/operator-sessions', { cookies: device }, {
    membership_id: S.members.door, event_id: S.event, pin: S.pin,
  });
  expect(ok.status).toBe(200);
  operatorSession = ok.body.operator_session_id;
  kiosk = mergeCookies(ok.res, { ...device });
});

const stockOf = async (productId: string) => {
  const list = await call('GET', storeUrl('/products'), { cookies: admin });
  return list.body.items.find((x: { id: string }) => x.id === productId)!
    .stock_on_hand as number;
};

describe('concurrency', () => {
  it('two POS orders racing for the last unit: exactly one commits', async () => {
    const p = await call('POST', storeUrl('/products'),
      { cookies: admin, idem: 'race-p1' }, {
        sku: 'RACE-1', name: 'Last bottle', kind: 'BOTTLE',
        price_minor: 1000, stock_tracked: true, initial_stock: 1,
      });
    expect(p.status).toBe(201);
    const productId = p.body.product_id as string;
    const [a, b] = await Promise.all([
      call('POST', evUrl('/pos/orders'), { cookies: kiosk, operatorSession, idem: 'race-o1' },
        { lines: [{ product_id: productId, quantity: 1 }], method: 'CASH' }),
      call('POST', evUrl('/pos/orders'), { cookies: kiosk, operatorSession, idem: 'race-o2' },
        { lines: [{ product_id: productId, quantity: 1 }], method: 'CASH' }),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.filter((s) => s === 201).length).toBe(1);
    expect(statuses.filter((s) => [409, 422].includes(s)).length).toBe(1);
    expect(await stockOf(productId)).toBe(0);
  });

  it('same idempotency key fired twice in parallel: one side effect', async () => {
    const p = await call('POST', storeUrl('/products'),
      { cookies: admin, idem: 'race-p2' }, {
        sku: 'RACE-2', name: 'Replay bottle', kind: 'BOTTLE',
        price_minor: 1000, stock_tracked: true, initial_stock: 5,
      });
    expect(p.status).toBe(201);
    const productId = p.body.product_id as string;
    const body = { lines: [{ product_id: productId, quantity: 1 }], method: 'CASH' };
    const [a, b] = await Promise.all([
      call('POST', evUrl('/pos/orders'), { cookies: kiosk, operatorSession, idem: 'race-replay' }, body),
      call('POST', evUrl('/pos/orders'), { cookies: kiosk, operatorSession, idem: 'race-replay' }, body),
    ]);
    // Winner commits the order; the concurrent same-key caller either
    // replays the stored receipt (same order_id) or gets a retryable
    // COMMAND_IN_PROGRESS. Never a second decrement.
    for (const r of [a, b]) expect([201, 409]).toContain(r.status);
    const orderIds = [a, b]
      .filter((r) => r.status === 201)
      .map((r) => r.body.order_id);
    expect(new Set(orderIds).size).toBeLessThanOrEqual(1);
    expect(await stockOf(productId)).toBe(4);
  });

  it('two decisions racing on one approval request: first wins', async () => {
    const v = await call('POST', evUrl('/visits'),
      { cookies: promoter, idem: 'race-v1' }, {
        reception_name: 'レース 花子', planned_count: 2,
        segments: [{ rule_key: 'guest_free', count: 2 }],
      });
    expect(v.status).toBe(201);
    const list = await call('GET', evUrl('/approvals?status=PENDING'),
      { cookies: kiosk, operatorSession });
    const req0 = list.body.items.find(
      (x: { status: string; visit_id: string }) => x.visit_id === v.body.id);
    expect(req0).toBeTruthy();
    const decide = (decision: 'APPROVED' | 'REJECTED', key: string) =>
      call('POST', evUrl(`/approvals/${req0.id}/decisions`),
        { cookies: kiosk, operatorSession, idem: key }, {
          expected_request_version: req0.version,
          expected_segment_version: req0.segment_version,
          decision,
        });
    const [a, b] = await Promise.all([
      decide('APPROVED', 'race-d1'), decide('REJECTED', 'race-d2')]);
    const statuses = [a.status, b.status];
    expect(statuses.filter((s) => s === 200).length).toBe(1);
    expect(statuses.filter((s) => [409, 422].includes(s)).length).toBe(1);
  });
});
