// VIP bookings: deposit checkout + dev PSP webhook regression tests.
// Covers F-001 (checkout previously always failed: sales_orders.visit_id and
// payments.order_id schema mismatch) and the webhook bug that confirmed
// EVERY held table allocation in the event instead of only the paid booking's.
import { describe, it, expect, beforeAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { call, devLogin, seed, type Cookies } from '../helpers.js';
import { config } from '../../src/server/config.js';

process.env.WORKER_AUTOSTART = '0';

const S = seed();
const evUrl = (p: string) => `/stores/${S.store}/events/${S.event}${p}`;
const storeUrl = (p: string) => `/stores/${S.store}${p}`;
const sign = (ref: string, result: string) =>
  createHmac('sha256', config.snapshotSecret)
    .update(`devpsp:${ref}:${result}`).digest('hex');

let admin: Cookies;
let tableA: string, tableB: string;

beforeAll(async () => {
  admin = await devLogin('admin');
  const mk = async (code: string, idem: string) => {
    const r = await call('POST', storeUrl('/tables'), { cookies: admin, idem },
      { table_code: code, zone: 'VIP', capacity_min: 2, capacity_max: 8 });
    expect(r.status).toBe(201);
    return r.body.table_id as string;
  };
  tableA = await mk('V-T1', 'vt1');
  tableB = await mk('V-T2', 'vt2');
});

async function bookings() {
  const r = await call('GET', evUrl('/bookings'), { cookies: admin });
  expect(r.status).toBe(200);
  return r.body.items as {
    id: string; status: string; tables: string[] | null;
  }[];
}

describe('VIP deposit checkout + webhook (F-001 regression)', () => {
  let bookingA: string, bookingB: string, refA: string, refB: string;

  it('creates two held bookings with deposits on separate tables', async () => {
    const mk = async (tableId: string, idem: string) => {
      const r = await call('POST', evUrl('/bookings'), { cookies: admin, idem }, {
        customer_id: S.customers.sato, party_count: 4,
        starts_at: new Date(Date.now() + 3600e3).toISOString(),
        ends_at: new Date(Date.now() + 7200e3).toISOString(),
        minimum_minor: 30000, deposit_minor: 5000, table_ids: [tableId],
      });
      expect(r.status).toBe(201);
      expect(r.body.status).toBe('HOLD');
      return r.body.booking_id as string;
    };
    bookingA = await mk(tableA, 'ba1');
    bookingB = await mk(tableB, 'bb1');
  });

  it('checkout creates payment + order and moves booking to PAYMENT_PENDING', async () => {
    const r = await call('POST', evUrl(`/bookings/${bookingA}/checkout`),
      { cookies: admin, idem: 'co1' });
    expect(r.status).toBe(201);
    expect(r.body.provider_reference).toMatch(/^devpsp_/);
    refA = r.body.provider_reference;
    const bs = await bookings();
    expect(bs.find((x) => x.id === bookingA)?.status).toBe('PAYMENT_PENDING');
  });

  it('checkout is idempotent under the same key', async () => {
    const r = await call('POST', evUrl(`/bookings/${bookingA}/checkout`),
      { cookies: admin, idem: 'co1' });
    expect(r.status).toBe(201);
    expect(r.body.provider_reference).toBe(refA);
  });

  it('rejects a webhook with a bad signature', async () => {
    const r = await call('POST', '/integrations/devpsp/webhooks', {}, {
      provider_reference: refA, result: 'success', signature: 'bad',
    });
    expect(r.status).toBe(401);
  });

  it('success webhook confirms only the paid booking and its table', async () => {
    const r = await call('POST', '/integrations/devpsp/webhooks', {}, {
      provider_reference: refA, result: 'success', signature: sign(refA, 'success'),
    });
    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(true);
    expect(r.body.duplicate).toBe(false);
    const bs = await bookings();
    const a = bs.find((x) => x.id === bookingA)!;
    const b = bs.find((x) => x.id === bookingB)!;
    expect(a.status).toBe('CONFIRMED');
    // F-001: booking B was never paid — it must stay HOLD, not be swept up
    // by the old "confirm every held allocation" bug.
    expect(b.status).toBe('HOLD');
  });

  it('duplicate webhook is idempotent', async () => {
    const r = await call('POST', '/integrations/devpsp/webhooks', {}, {
      provider_reference: refA, result: 'success', signature: sign(refA, 'success'),
    });
    expect(r.status).toBe(200);
    expect(r.body.duplicate).toBe(true);
    const bs = await bookings();
    expect(bs.find((x) => x.id === bookingA)?.status).toBe('CONFIRMED');
  });

  it('failure webhook marks the booking PAYMENT_EXCEPTION', async () => {
    const co = await call('POST', evUrl(`/bookings/${bookingB}/checkout`),
      { cookies: admin, idem: 'co2' });
    expect(co.status).toBe(201);
    refB = co.body.provider_reference;
    const r = await call('POST', '/integrations/devpsp/webhooks', {}, {
      provider_reference: refB, result: 'failure', signature: sign(refB, 'failure'),
    });
    expect(r.status).toBe(200);
    const bs = await bookings();
    expect(bs.find((x) => x.id === bookingB)?.status).toBe('PAYMENT_EXCEPTION');
  });

  it('checkout on a zero-deposit confirmed booking is rejected', async () => {
    const bk = await call('POST', evUrl('/bookings'), { cookies: admin, idem: 'bc1' }, {
      customer_id: S.customers.sato, party_count: 2,
      starts_at: new Date(Date.now() + 3600e3).toISOString(),
      ends_at: new Date(Date.now() + 7200e3).toISOString(),
      minimum_minor: 0, deposit_minor: 0, table_ids: [],
    });
    expect(bk.status).toBe(201);
    const r = await call('POST', evUrl(`/bookings/${bk.body.booking_id}/checkout`),
      { cookies: admin, idem: 'co3' });
    expect([409, 422]).toContain(r.status);
  });
});
