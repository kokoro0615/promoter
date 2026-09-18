// R2/R3 slice: SaaS platform (EP24/25) + tickets (EP26) + POS/inventory/
// bottle keeps (EP27). Uses the same seeded test DB as r1.test.ts.
import { describe, it, expect, beforeAll } from 'vitest';
import { call, devLogin, mergeCookies, seed, type Cookies } from '../helpers.js';

process.env.WORKER_AUTOSTART = '0';

const S = seed() as ReturnType<typeof seed> & { plans: Record<string, string> };
const storeUrl = (p: string) => `/stores/${S.store}${p}`;
const evUrl = (p: string) => `/stores/${S.store}/events/${S.event}${p}`;

let admin: Cookies, promoter: Cookies, saas: Cookies;
let kiosk: Cookies, operatorSession: string;

beforeAll(async () => {
  admin = await devLogin('admin');
  promoter = await devLogin('promoter');
  saas = await devLogin('saas');
  // entrance device + operator for redeem flow
  const enr = await call('POST', storeUrl('/devices/enrollments'),
    { cookies: admin }, { label: 'R2 iPad' });
  const pair = await call('POST', '/device/enroll', {},
    { pairing_code: enr.body.pairing_code });
  const device = mergeCookies(pair.res);
  const ok = await call('POST', '/device/operator-sessions', { cookies: device }, {
    membership_id: S.members.door, event_id: S.event, pin: S.pin,
  });
  expect(ok.status).toBe(200);
  operatorSession = ok.body.operator_session_id;
  kiosk = mergeCookies(ok.res, { ...device });
});

describe('EP24/25 platform', () => {
  let tenantId: string, subId: string, invoiceId: string, delId: string;

  it('non-operator cannot list tenants', async () => {
    const r = await call('GET', '/platform/tenants', { cookies: admin });
    expect(r.status).toBe(403);
  });

  it('platform operator creates tenant with onboarding items', async () => {
    const r = await call('POST', '/platform/tenants', { cookies: saas, idem: 't1' },
      { name: 'Acme Clubs' });
    expect(r.status).toBe(201);
    tenantId = r.body.tenant_id;
    const ob = await call('GET', `/platform/tenants/${tenantId}/onboarding`,
      { cookies: saas });
    expect(ob.body.items.length).toBe(5);
    const done = await call('PUT',
      `/platform/tenants/${tenantId}/onboarding/store_created`,
      { cookies: saas }, { done: true });
    expect(done.body.done).toBe(true);
  });

  it('subscription lifecycle: trial -> active -> invoice -> paid', async () => {
    const sub = await call('POST', `/platform/tenants/${tenantId}/subscription`,
      { cookies: saas, idem: 's1' }, { plan_id: S.plans.basic, trial_days: 7 });
    expect(sub.status).toBe(201);
    subId = sub.body.subscription_id;
    expect(sub.body.status).toBe('TRIAL');
    // version is 1 after insert
    const tr = await call('POST', `/platform/subscriptions/${subId}/transition`,
      { cookies: saas, idem: 's2' }, { status: 'ACTIVE', expected_version: 1 });
    expect(tr.status).toBe(200);
    expect(tr.body.status).toBe('ACTIVE');

    const inv = await call('POST', `/platform/tenants/${tenantId}/invoices`,
      { cookies: saas, idem: 'i1' }, {
        subscription_id: subId,
        period_start: new Date().toISOString(),
        period_end: new Date(Date.now() + 30 * 86400e3).toISOString(),
        amount_minor: 0, // D-10: price unset -> 0 allowed
      });
    expect(inv.status).toBe(201);
    invoiceId = inv.body.invoice_id;
    const issue = await call('POST', `/platform/invoices/${invoiceId}/transition`,
      { cookies: saas, idem: 'i2' }, { status: 'ISSUED', expected_version: 1 });
    expect(issue.body.status).toBe('ISSUED');
    const paid = await call('POST', `/platform/invoices/${invoiceId}/transition`,
      { cookies: saas, idem: 'i3' }, { status: 'PAID', expected_version: 2 });
    expect(paid.body.status).toBe('PAID');
    const again = await call('POST', `/platform/invoices/${invoiceId}/transition`,
      { cookies: saas, idem: 'i4' }, { status: 'FAILED', expected_version: 3 });
    expect([409, 422]).toContain(again.status); // terminal state
  });

  it('deletion request: schedule then cancel', async () => {
    const d = await call('POST', `/platform/tenants/${tenantId}/deletion-requests`,
      { cookies: saas, idem: 'd1' },
      { execute_after: new Date(Date.now() + 30 * 86400e3).toISOString() });
    expect(d.status).toBe(201);
    delId = d.body.deletion_request_id;
    const cancel = await call('POST',
      `/platform/deletion-requests/${delId}/cancel`,
      { cookies: saas, idem: 'd2' }, { expected_version: 1 });
    expect(cancel.body.status).toBe('CANCELED');
    const dup = await call('POST', `/platform/tenants/${tenantId}/deletion-requests`,
      { cookies: saas, idem: 'd3' },
      { execute_after: new Date(Date.now() + 60 * 86400e3).toISOString() });
    expect(dup.status).toBe(201); // previous was canceled -> new schedule allowed
  });

  it('usage endpoint aggregates per tenant', async () => {
    const u = await call('GET', '/platform/usage', { cookies: saas });
    expect(u.status).toBe(200);
    const dev = u.body.items.find((x: { tenant_id: string }) => x.tenant_id === S.tenant);
    expect(dev).toBeTruthy();
    expect(dev.stores).toBeGreaterThanOrEqual(1);
  });

  it('store settings: admin can update currency, promoter cannot', async () => {
    const no = await call('PATCH', storeUrl(''), { cookies: promoter },
      { name: 'X' });
    expect(no.status).toBe(403);
    const ok = await call('PATCH', storeUrl(''), { cookies: admin },
      { name: 'Dev Club Alpha' });
    expect(ok.status).toBe(200);
    expect(ok.body.store.name).toBe('Dev Club Alpha');
  });
});

describe('EP26 tickets', () => {
  let productId: string, orderId: string, tokens: { ticket_id: string; token: string }[];

  it('create ticket product', async () => {
    const r = await call('POST', evUrl('/ticket-products'),
      { cookies: admin, idem: 'tp1' }, {
        code: 'early', name: 'Early bird', price_minor: 1500,
        sales_from: new Date(Date.now() - 3600e3).toISOString(),
        sales_to: new Date(Date.now() + 86400e3).toISOString(),
        quantity_limit: 3, per_order_limit: 2,
      });
    expect(r.status).toBe(201);
    productId = r.body.ticket_product_id;
  });

  it('order over per-order limit is rejected', async () => {
    const r = await call('POST', evUrl('/ticket-orders'),
      { cookies: admin, idem: 'to0' }, {
        product_id: productId, quantity: 5, buyer_name: 'Buyer One',
        method: 'CASH',
      });
    expect([409, 422]).toContain(r.status);
  });

  it('order issues tokens and a SUCCEEDED payment', async () => {
    const r = await call('POST', evUrl('/ticket-orders'),
      { cookies: admin, idem: 'to1' }, {
        product_id: productId, quantity: 2, buyer_name: 'Buyer One',
        method: 'CASH',
      });
    expect(r.status).toBe(201);
    orderId = r.body.ticket_order_id;
    tokens = r.body.tickets;
    expect(tokens.length).toBe(2);
    expect(r.body.amount_minor).toBe(3000);
  });

  it('redeem at entrance creates a visit and is one-shot', async () => {
    const r = await call('POST', evUrl('/tickets/redeem'),
      { cookies: kiosk, operatorSession, idem: 're1' },
      { token: tokens[0]!.token });
    expect(r.status).toBe(200);
    expect(r.body.visit.segments[0].authorization_method).toBe('TICKET');
    expect(r.body.visit.segments[0].first_entered_count).toBe(1);
    const again = await call('POST', evUrl('/tickets/redeem'),
      { cookies: kiosk, operatorSession, idem: 're2' },
      { token: tokens[0]!.token });
    expect([409, 422]).toContain(again.status);
  });

  it('cancel of an order with a redeemed ticket is refused', async () => {
    const detail = await call('GET', evUrl(`/ticket-orders/${orderId}`),
      { cookies: admin });
    const c = await call('POST', evUrl(`/ticket-orders/${orderId}/cancel`),
      { cookies: admin, idem: 'cx1' },
      { expected_version: detail.body.order.version });
    expect([409, 422]).toContain(c.status);
  });

  it('quantity limit blocks overselling', async () => {
    // sold=2 of limit=3, buying 2 more would exceed
    const r = await call('POST', evUrl('/ticket-orders'),
      { cookies: admin, idem: 'to2' }, {
        product_id: productId, quantity: 2, buyer_name: 'Buyer Two',
        method: 'CASH',
      });
    expect(r.status).toBe(409);
  });
});

describe('EP27 pos / inventory / bottles', () => {
  let productId: string, keepId: string;

  it('create product with initial stock', async () => {
    const r = await call('POST', storeUrl('/products'),
      { cookies: admin, idem: 'p1' }, {
        sku: 'DRC-750', name: 'Dom Perignon', kind: 'BOTTLE',
        price_minor: 50000, stock_tracked: true, initial_stock: 2,
      });
    expect(r.status).toBe(201);
    productId = r.body.product_id;
  });

  it('POS order decrements stock and writes ledger', async () => {
    const r = await call('POST', evUrl('/pos/orders'),
      { cookies: kiosk, operatorSession, idem: 'pos1' }, {
        lines: [{ product_id: productId, quantity: 1 }], method: 'CASH',
      });
    expect(r.status).toBe(201);
    expect(r.body.total_minor).toBe(50000);
    const list = await call('GET', storeUrl('/products'), { cookies: admin });
    expect(list.body.items[0].stock_on_hand).toBe(1);
  });

  it('sold-out order is rejected (no oversell)', async () => {
    const r = await call('POST', evUrl('/pos/orders'),
      { cookies: kiosk, operatorSession, idem: 'pos2' }, {
        lines: [{ product_id: productId, quantity: 5 }], method: 'CASH',
      });
    expect([409, 422]).toContain(r.status);
  });

  it('restock via stock movement', async () => {
    const r = await call('POST', storeUrl(`/products/${productId}/stock`),
      { cookies: admin, idem: 'st1' }, { kind: 'IN', quantity: 3, ref: 'restock' });
    expect(r.status).toBe(200);
    expect(r.body.stock_on_hand).toBe(4);
    const mv = await call('GET', storeUrl(`/products/${productId}/movements`),
      { cookies: admin });
    expect(mv.body.items.map((x: { kind: string }) => x.kind)).toContain('SALE');
  });

  it('bottle keep lifecycle', async () => {
    const r = await call('POST', storeUrl('/bottle-keeps'),
      { cookies: admin, idem: 'bk1' }, {
        customer_id: S.customers.sato, product_id: productId,
        label: 'SATO 2026-09', expires_at: new Date(Date.now() + 90 * 86400e3).toISOString(),
      });
    expect(r.status).toBe(201);
    keepId = r.body.bottle_keep_id;
    const list = await call('GET',
      storeUrl(`/bottle-keeps?customer_id=${S.customers.sato}`), { cookies: admin });
    expect(list.body.items[0].status).toBe('OPEN');
    const close = await call('PATCH', storeUrl(`/bottle-keeps/${keepId}`),
      { cookies: admin, idem: 'bk2' }, { status: 'FINISHED', remaining_percent: 0, expected_version: 1 });
    expect(close.body.status).toBe('FINISHED');
  });
});

describe('EP25 export jobs', () => {
  it('queued export is executed by worker and downloadable', async () => {
    const j = await call('POST', storeUrl('/exports'),
      { cookies: admin, idem: 'ex1' }, { report_kind: 'visits', format: 'CSV' });
    expect(j.status).toBe(201);
    const { runOnce } = await import('../../src/worker/index.js');
    await runOnce();
    const list = await call('GET', storeUrl('/exports'), { cookies: admin });
    const job = list.body.items.find((x: { id: string }) => x.id === j.body.export_job_id);
    expect(job.status).toBe('READY');
    const dl = await call('GET', storeUrl(`/exports/${job.id}/download`),
      { cookies: admin });
    expect(dl.status).toBe(200);
    expect(dl.res.headers['content-type']).toContain('text/csv');
    // promoter lacks report.export
    const no = await call('GET', storeUrl(`/exports/${job.id}/download`),
      { cookies: promoter });
    expect(no.status).toBe(403);
  });
});
