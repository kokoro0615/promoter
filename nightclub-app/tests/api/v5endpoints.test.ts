// Phase 3c endpoint coverage: roles, membership role assignment, notification
// inbox, customer detail/tags, event update/duplicate/cancel, visit
// segments/members/passes, orders list, quotations, reward
// statements/disputes/payouts, provisional reconcile, ticket lifecycle,
// stocktakes, campaigns, forecasts, platform operators/stores.
import { beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { call, devLogin, seed, type Cookies } from '../helpers.js';

process.env.WORKER_AUTOSTART = '0';

const S = seed();
const storeUrl = (p: string) => `/stores/${S.store}${p}`;
const evUrl = (p: string) => storeUrl(`/events/${S.event}${p}`);

let admin: Cookies, promoter: Cookies, saas: Cookies, rival: Cookies;
let sql: pg.Client;

beforeAll(async () => {
  admin = await devLogin('admin');
  promoter = await devLogin('promoter');
  saas = await devLogin('saas');
  rival = await devLogin('rival');
  sql = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await sql.connect();
});

// ---------- roles / membership roles / notifications -------------------------
describe('roles + membership role assignment + notifications', () => {
  it('GET /roles lists store roles with permission keys', async () => {
    const r = await call('GET', storeUrl('/roles'), { cookies: admin });
    expect(r.status).toBe(200);
    const keys = r.body.items.map((x: { role_key: string }) => x.role_key);
    for (const k of ['ADMIN', 'PROMOTER', 'ENTRANCE', 'APPROVER']) {
      expect(keys).toContain(k);
    }
    const adminRole = r.body.items.find(
      (x: { role_key: string }) => x.role_key === 'ADMIN');
    expect(adminRole.permissions).toContain('event.manage');
  });

  it('PUT /memberships/:id/roles replaces the role set', async () => {
    const ms = await call('GET', storeUrl('/memberships'), { cookies: admin });
    expect(ms.status).toBe(200);
    const approver = ms.body.items.find(
      (x: { id: string }) => x.id === S.members.approver);
    expect(approver).toBeTruthy();
    const roles = await call('GET', storeUrl('/roles'), { cookies: admin });
    const approverRole = roles.body.items.find(
      (x: { role_key: string }) => x.role_key === 'APPROVER');
    const r = await call(
      'PUT', storeUrl(`/memberships/${S.members.approver}/roles`),
      { cookies: admin },
      { role_ids: [approverRole.id], expected_version: approver.version });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('UPDATED');
  });

  it('notification inbox lists IN_APP jobs and read is idempotent', async () => {
    const ins = await sql.query(
      `INSERT INTO nightclub.notification_jobs
         (tenant_id, store_id, event_id, recipient_membership_id, channel,
          dedup_key, status, scheduled_at, payload)
       VALUES ($1,$2,$3,$4,'IN_APP','test:notif:1','SENT',CURRENT_TIMESTAMP,
               '{"title":"テスト通知"}') RETURNING id`,
      [S.tenant, S.store, S.event, S.members.promoter]);
    const nid = ins.rows[0].id as string;
    const inbox = await call('GET', storeUrl('/me/notifications'),
      { cookies: promoter });
    expect(inbox.status).toBe(200);
    const item = inbox.body.items.find((x: { id: string }) => x.id === nid);
    expect(item).toBeTruthy();
    expect(item.read_at).toBeNull();
    const read = await call(
      'POST', storeUrl(`/me/notifications/${nid}/read`), { cookies: promoter });
    expect(read.status).toBe(200);
    const unread = await call(
      'GET', storeUrl('/me/notifications?unread_only=true'),
      { cookies: promoter });
    expect(unread.body.items.find((x: { id: string }) => x.id === nid))
      .toBeUndefined();
    const other = await call(
      'POST', storeUrl(`/me/notifications/${nid}/read`), { cookies: admin });
    expect(other.status).toBe(404);
  });
});

// ---------- customer detail + tags -------------------------------------------
describe('customer detail + tags', () => {
  it('GET /customers/:id returns profile, aliases, visits, keeps', async () => {
    const r = await call('GET', storeUrl(`/customers/${S.customers.sato}`),
      { cookies: promoter });
    expect(r.status).toBe(200);
    expect(r.body.customer.id).toBe(S.customers.sato);
    expect(Array.isArray(r.body.aliases)).toBe(true);
    expect(Array.isArray(r.body.recent_visits)).toBe(true);
  });

  it('cross-tenant access is denied', async () => {
    const r = await call('GET', storeUrl(`/customers/${S.customers.sato}`),
      { cookies: rival });
    expect([401, 403]).toContain(r.status);
  });

  it('tag create -> assign -> list -> unassign', async () => {
    const t = await call('POST', storeUrl('/customer-tags'),
      { cookies: admin }, { tag_key: 'vip', label: 'VIP顧客' });
    expect(t.status).toBe(201);
    const tagId = t.body.tag_id as string;
    const a = await call(
      'PUT', storeUrl(`/customers/${S.customers.sato}/tags/${tagId}`),
      { cookies: admin });
    expect(a.status).toBe(201);
    const list = await call('GET', storeUrl('/customer-tags'),
      { cookies: admin });
    const tag = list.body.items.find(
      (x: { id: string }) => x.id === tagId);
    expect(tag.customers).toBe(1);
    const d = await call(
      'DELETE', storeUrl(`/customers/${S.customers.sato}/tags/${tagId}`),
      { cookies: admin });
    expect(d.status).toBe(200);
  });
});

// ---------- event update / duplicate / cancel --------------------------------
describe('event update + duplicate + cancel', () => {
  let ev2: string; let ev2Version: number;

  it('creates a fresh event', async () => {
    const r = await call('POST', storeUrl('/events'), { cookies: admin }, {
      name: 'v5テスト公演',
      opens_at: new Date(Date.now() + 86400e3).toISOString(),
      closes_at: new Date(Date.now() + 90000e3).toISOString(),
    });
    expect(r.status).toBe(201);
    ev2 = r.body.id;
    ev2Version = r.body.version;
  });

  it('PATCH updates name while DRAFT', async () => {
    const r = await call('PATCH', storeUrl(`/events/${ev2}`),
      { cookies: admin }, { expected_version: ev2Version, name: 'v5改名公演' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('UPDATED');
    ev2Version = r.body.version;
  });

  it('PATCH rejects stale version', async () => {
    const r = await call('PATCH', storeUrl(`/events/${ev2}`),
      { cookies: admin }, { expected_version: 1, name: 'x' });
    expect(r.status).toBe(409);
  });

  it('duplicate copies policy + assignments into a new DRAFT event', async () => {
    const r = await call('POST', evUrl('/duplicate'), { cookies: admin }, {
      name: '複製公演',
      opens_at: new Date(Date.now() + 172800e3).toISOString(),
      closes_at: new Date(Date.now() + 176400e3).toISOString(),
    });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('DRAFT');
    const pol = await call(
      'GET', storeUrl(`/events/${r.body.event_id}/policy-versions`),
      { cookies: admin });
    expect(pol.status).toBe(200);
    expect(pol.body.items.length).toBeGreaterThanOrEqual(1);
    expect(pol.body.items[0].status).toBe('DRAFT');
  });

  it('cancel works on DRAFT and is final', async () => {
    const r = await call('POST', storeUrl(`/events/${ev2}/cancel`),
      { cookies: admin }, { expected_version: ev2Version, reason: '中止' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('CANCELED');
    const again = await call('POST', storeUrl(`/events/${ev2}/cancel`),
      { cookies: admin }, { expected_version: r.body.version });
    expect([409, 422]).toContain(again.status);
  });
});

// ---------- visit segments / members / passes --------------------------------
describe('visit segments + companion members + pass lookup', () => {
  let visitId: string; let visitVersion: number; let memberId: string;

  it('creates a visit for segment work', async () => {
    const r = await call('POST', evUrl('/visits'),
      { cookies: promoter, idem: 'v5-seg-1' }, {
        reception_name: '連結テスト', planned_count: 4,
        referrer_membership_id: S.members.promoter,
        segments: [{ rule_key: 'guest_free', count: 1 }],
      });
    expect(r.status).toBe(201);
    visitId = r.body.id;
    visitVersion = r.body.version ?? r.body.visit?.version;
    const v = await call('GET', evUrl(`/visits/${visitId}`), { cookies: admin });
    visitVersion = v.body.version;
  });

  it('adds an admission segment to the existing visit', async () => {
    const r = await call('POST', evUrl(`/visits/${visitId}/segments`),
      { cookies: promoter, idem: 'v5-seg-2' }, {
        expected_visit_version: visitVersion, rule_key: 'guest_free', count: 2,
      });
    expect(r.status).toBe(201);
    expect(['PENDING', 'AUTHORIZED']).toContain(r.body.status);
  });

  it('rejects a segment beyond planned_count', async () => {
    const v = await call('GET', evUrl(`/visits/${visitId}`), { cookies: admin });
    const r = await call('POST', evUrl(`/visits/${visitId}/segments`),
      { cookies: promoter, idem: 'v5-seg-3' }, {
        expected_visit_version: v.body.version,
        rule_key: 'guest_free', count: 99,
      });
    expect([409, 422]).toContain(r.status);
  });

  it('adds and removes a companion member', async () => {
    const r = await call('POST', evUrl(`/visits/${visitId}/members`),
      { cookies: promoter, idem: 'v5-mem-1' }, {
        display_name: '同伴者A', customer_id: S.customers.yamada1,
      });
    expect(r.status).toBe(201);
    memberId = r.body.visit_member_id;
    const d = await call(
      'DELETE', evUrl(`/visits/${visitId}/members/${memberId}`),
      { cookies: promoter, idem: 'v5-mem-2' });
    expect(d.status).toBe(200);
  });

  it('pass lookup by visit_id returns items; bad token is 404', async () => {
    const r = await call('GET', evUrl(`/passes?visit_id=${visitId}`),
      { cookies: admin });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items)).toBe(true);
    const t = await call('GET', evUrl('/passes?token=nosuchtoken123'),
      { cookies: admin });
    expect(t.status).toBe(404);
  });
});

// ---------- orders list + quotations -----------------------------------------
describe('orders list + quotations', () => {
  it('GET /orders lists event orders', async () => {
    const mk = await call('POST', evUrl('/orders'),
      { cookies: admin, idem: 'v5-ord-1' }, { kind: 'IN_VENUE' });
    expect(mk.status).toBe(201);
    const r = await call('GET', evUrl('/orders'), { cookies: admin });
    expect(r.status).toBe(200);
    const found = r.body.items.find(
      (x: { id: string }) => x.id === mk.body.order_id);
    expect(found).toBeTruthy();
    expect(found.kind).toBe('IN_VENUE');
  });

  it('quotation create -> issue -> accept lifecycle', async () => {
    const q = await call('POST', evUrl('/quotations'),
      { cookies: admin, idem: 'v5-quo-1' }, {
        note: '貸切見積',
        lines: [
          { description: '席料', quantity: 1, unit_minor: 50000 },
          { description: 'シャンパン', quantity: 2, unit_minor: 30000 },
        ],
      });
    expect(q.status).toBe(201);
    expect(q.body.total_minor).toBe(110000);
    const detail = await call('GET', evUrl(`/quotations/${q.body.quotation_id}`),
      { cookies: admin });
    expect(detail.body.lines.length).toBe(2);
    const issue = await call(
      'POST', evUrl(`/quotations/${q.body.quotation_id}/issue`),
      { cookies: admin, idem: 'v5-quo-2' },
      { expected_version: detail.body.quotation.version });
    expect(issue.status).toBe(200);
    const accept = await call(
      'POST', evUrl(`/quotations/${q.body.quotation_id}/transition`),
      { cookies: admin, idem: 'v5-quo-3' },
      { expected_version: 2, status: 'ACCEPTED' });
    expect(accept.status).toBe(200);
    const list = await call('GET', evUrl('/quotations?status=ACCEPTED'),
      { cookies: admin });
    expect(list.body.items.find(
      (x: { id: string }) => x.id === q.body.quotation_id)).toBeTruthy();
  });
});

// ---------- rewards: statements / disputes / payouts -------------------------
describe('reward statements + disputes + settlement payments', () => {
  let settlementId: string; let lineId: string;

  it('builds a settlement with attributed sales', async () => {
    await sql.query(
      `INSERT INTO nightclub.reward_rules
         (tenant_id, store_id, rule_key, version, referrer_membership_id,
          conditions, valid_from, valid_to)
       VALUES ($1,$2,gen_random_uuid(),1,$3,'{"basis_points":1000}',
               CURRENT_TIMESTAMP - interval '1 day',
               CURRENT_TIMESTAMP + interval '30 days')`,
      [S.tenant, S.store, S.members.promoter]);
    const ord = await sql.query(
      `INSERT INTO nightclub.sales_orders
         (tenant_id, store_id, event_id, kind, visit_id, currency, status)
       VALUES ($1,$2,$3,'IN_VENUE',NULL,'JPY','FINALIZED') RETURNING id`,
      [S.tenant, S.store, S.event]);
    const ln = await sql.query(
      `INSERT INTO nightclub.sales_lines
         (tenant_id, store_id, event_id, order_id, category, line_kind,
          description, quantity, gross_minor, tax_minor, currency, source_key)
       VALUES ($1,$2,$3,$4,'IN_VENUE','SALE','店内販売',1,100000,0,'JPY',
               'test:v5:line1') RETURNING id`,
      [S.tenant, S.store, S.event, ord.rows[0].id]);
    await sql.query(
      `INSERT INTO nightclub.sales_attributions
         (tenant_id, store_id, event_id, sales_line_id,
          referrer_membership_id, basis_points)
       VALUES ($1,$2,$3,$4,$5,1000)`,
      [S.tenant, S.store, S.event, ln.rows[0].id, S.members.promoter]);
    const r = await call('POST', evUrl('/settlements'), { cookies: admin });
    expect(r.status).toBe(201);
    settlementId = r.body.settlement_id;
    const fin = await call(
      'POST', evUrl(`/settlements/${settlementId}/finalize`),
      { cookies: admin }, { expected_version: r.body.version });
    expect(fin.status).toBe(200);
  });

  it('reward-statements groups lines per referrer', async () => {
    const r = await call('GET', evUrl('/reward-statements'),
      { cookies: admin });
    expect(r.status).toBe(200);
    const st = r.body.statements.find(
      (x: { referrer_membership_id: string }) =>
        x.referrer_membership_id === S.members.promoter);
    expect(st).toBeTruthy();
    expect(Number(st.amount_minor)).toBe(10000);
    lineId = r.body.lines.find(
      (x: { referrer_membership_id: string }) =>
        x.referrer_membership_id === S.members.promoter).id;
  });

  it('referrer sees only own statement via report.own', async () => {
    const r = await call('GET', evUrl('/reward-statements'),
      { cookies: promoter });
    expect(r.status).toBe(200);
    for (const st of r.body.statements) {
      expect(st.referrer_membership_id).toBe(S.members.promoter);
    }
  });

  it('dispute raise -> list -> resolve with adjustment', async () => {
    const d = await call('POST', evUrl('/reward-disputes'),
      { cookies: promoter, idem: 'v5-disp-1' }, {
        settlement_line_id: lineId, reason: '金額が違います',
      });
    expect(d.status).toBe(201);
    const list = await call('GET', evUrl('/reward-disputes'),
      { cookies: promoter });
    const row = list.body.items.find(
      (x: { id: string }) => x.id === d.body.dispute_id);
    expect(row.status).toBe('OPEN');
    const res = await call(
      'POST', evUrl(`/reward-disputes/${d.body.dispute_id}/resolve`),
      { cookies: admin, idem: 'v5-disp-2' }, {
        expected_version: row.version, status: 'RESOLVED',
        resolution: '差額調整', adjustment_minor: 1000,
      });
    expect(res.status).toBe(200);
  });

  it('records an external payout on the FINALIZED settlement', async () => {
    const r = await call('POST', evUrl('/settlement-payments'),
      { cookies: admin, idem: 'v5-pay-1' }, {
        settlement_id: settlementId,
        referrer_membership_id: S.members.promoter,
        amount_minor: 11000, external_reference: 'bank-2026-001',
        paid_at: new Date().toISOString(),
      });
    expect(r.status).toBe(201);
    const list = await call('GET', evUrl('/settlement-payments'),
      { cookies: admin });
    expect(list.body.items.length).toBe(1);
    expect(list.body.items[0].amount_minor).toBe('11000');
  });
});

// ---------- provisional entries ----------------------------------------------
describe('provisional entries reconcile', () => {
  let entryId: string;

  it('import -> list -> reconcile REJECTED', async () => {
    const enr = await call('POST', storeUrl('/devices/enrollments'),
      { cookies: admin }, { label: 'v5 device' });
    expect(enr.status).toBe(201);
    const imp = await call('POST', evUrl('/provisional-entries/import'),
      { cookies: admin }, {
        entries: [{
          device_id: enr.body.device_id,
          local_operation_id: '11111111-2222-3333-4444-555555555555',
          device_time: new Date().toISOString(),
          quantity: 2, reception_name: 'オフライン来客', reason: '回線断',
        }],
      });
    expect(imp.status).toBe(201);
    expect(imp.body.imported).toBe(1);
    entryId = imp.body.ids[0];
    const list = await call(
      'GET', evUrl('/provisional-entries?status=UNRECONCILED'),
      { cookies: admin });
    expect(list.status).toBe(200);
    const row = list.body.items.find(
      (x: { id: string }) => x.id === entryId);
    expect(row).toBeTruthy();
    const rec = await call(
      'POST', evUrl(`/provisional-entries/${entryId}/reconcile`),
      { cookies: admin, idem: 'v5-rec-1' }, {
        expected_version: row.version, status: 'REJECTED',
      });
    expect(rec.status).toBe(200);
    const again = await call(
      'POST', evUrl(`/provisional-entries/${entryId}/reconcile`),
      { cookies: admin, idem: 'v5-rec-2' }, {
        expected_version: row.version + 1, status: 'REJECTED',
      });
    expect([409, 422]).toContain(again.status);
  });
});

// ---------- ticket lifecycle --------------------------------------------------
describe('ticket orders/instances + reissue/revoke/product patch', () => {
  let productId: string; let orderId: string;
  let tickets: { ticket_id: string; token: string }[];

  it('creates a product and an order', async () => {
    const p = await call('POST', evUrl('/ticket-products'),
      { cookies: admin, idem: 'v5-tp-1' }, {
        code: 'ADV1', name: '前売券', price_minor: 3000,
        sales_from: new Date(Date.now() - 3600e3).toISOString(),
        sales_to: new Date(Date.now() + 86400e3).toISOString(),
      });
    expect(p.status).toBe(201);
    productId = p.body.ticket_product_id;
    const o = await call('POST', evUrl('/ticket-orders'),
      { cookies: admin, idem: 'v5-to-1' }, {
        product_id: productId, quantity: 2, buyer_name: '購入者A',
        method: 'CASH',
      });
    expect(o.status).toBe(201);
    orderId = o.body.ticket_order_id;
    tickets = o.body.tickets;
    expect(tickets.length).toBe(2);
  });

  it('lists orders and instances', async () => {
    const os = await call('GET', evUrl('/ticket-orders'), { cookies: admin });
    expect(os.status).toBe(200);
    expect(os.body.items.find(
      (x: { id: string }) => x.id === orderId)).toBeTruthy();
    const ts = await call('GET', evUrl(`/tickets?order_id=${orderId}`),
      { cookies: admin });
    expect(ts.body.items.length).toBe(2);
  });

  it('reissue voids the old token and mints a new one', async () => {
    const r = await call('POST', evUrl(`/tickets/${tickets[0]!.ticket_id}/reissue`),
      { cookies: admin, idem: 'v5-ti-1' }, { reason: '端末紛失' });
    expect(r.status).toBe(201);
    expect(r.body.voided_ticket_id).toBe(tickets[0]!.ticket_id);
    expect(r.body.token).toBeTruthy();
    const ts = await call('GET', evUrl(`/tickets?order_id=${orderId}`),
      { cookies: admin });
    const old = ts.body.items.find(
      (x: { id: string }) => x.id === tickets[0]!.ticket_id);
    expect(old.status).toBe('VOID');
  });

  it('revoke voids an ISSUED ticket; redeemed/voided reject', async () => {
    const r = await call('POST', evUrl(`/tickets/${tickets[1]!.ticket_id}/revoke`),
      { cookies: admin, idem: 'v5-ti-2' }, { reason: '不正購入' });
    expect(r.status).toBe(200);
    const again = await call(
      'POST', evUrl(`/tickets/${tickets[1]!.ticket_id}/revoke`),
      { cookies: admin, idem: 'v5-ti-3' }, { reason: 'x' });
    expect([409, 422]).toContain(again.status);
  });

  it('PATCH product pauses sales; purchase then rejected', async () => {
    const list = await call('GET', evUrl('/ticket-products'), { cookies: admin });
    const prod = list.body.items.find(
      (x: { id: string }) => x.id === productId);
    const r = await call('PATCH', evUrl(`/ticket-products/${productId}`),
      { cookies: admin, idem: 'v5-tp-2' }, {
        expected_version: prod.version, status: 'PAUSED',
      });
    expect(r.status).toBe(200);
    const o = await call('POST', evUrl('/ticket-orders'),
      { cookies: admin, idem: 'v5-to-2' }, {
        product_id: productId, quantity: 1, buyer_name: 'B', method: 'CASH',
      });
    expect([409, 422]).toContain(o.status);
  });
});

// ---------- stocktakes ---------------------------------------------------------
describe('stocktakes', () => {
  let stocktakeId: string; let productId: string;

  it('open -> count -> close with adjustments', async () => {
    const p = await call('POST', storeUrl('/products'),
      { cookies: admin, idem: 'v5-pr-1' }, {
        sku: 'STK1', name: '棚卸商品', kind: 'ITEM', price_minor: 1000,
        stock_tracked: true, initial_stock: 5,
      });
    expect(p.status).toBe(201);
    productId = p.body.product_id;
    const s = await call('POST', storeUrl('/stocktakes'),
      { cookies: admin, idem: 'v5-st-1' }, { note: '月末棚卸' });
    expect(s.status).toBe(201);
    stocktakeId = s.body.stocktake_id;
    const detail = await call('GET', storeUrl(`/stocktakes/${stocktakeId}`),
      { cookies: admin });
    const line = detail.body.lines.find(
      (x: { product_id: string }) => x.product_id === productId);
    expect(line.expected_qty).toBe(5);
    const cnt = await call(
      'PUT', storeUrl(`/stocktakes/${stocktakeId}/lines`),
      { cookies: admin, idem: 'v5-st-2' }, {
        counts: [{ product_id: productId, counted_qty: 3 }],
      });
    expect(cnt.status).toBe(200);
    const close = await call(
      'POST', storeUrl(`/stocktakes/${stocktakeId}/transition`),
      { cookies: admin, idem: 'v5-st-3' }, {
        expected_version: detail.body.stocktake.version,
        status: 'CLOSED', apply_adjustments: true,
      });
    expect(close.status).toBe(200);
    expect(close.body.adjusted).toBe(1);
    const prods = await call('GET', storeUrl('/products'), { cookies: admin });
    const prod = prods.body.items.find(
      (x: { id: string }) => x.id === productId);
    expect(prod.stock_on_hand).toBe(3);
  });
});

// ---------- campaigns + forecasts ---------------------------------------------
describe('campaigns + forecasts', () => {
  it('campaign create -> dispatch -> deliveries', async () => {
    const c = await call('POST', storeUrl('/campaigns'),
      { cookies: admin, idem: 'v5-cp-1' }, {
        name: '週末告知', channel: 'IN_APP', body: '今週末イベント開催',
        segment: { regular_status: 'DESIGNATED' },
      });
    expect(c.status).toBe(201);
    const list = await call('GET', storeUrl('/campaigns'), { cookies: admin });
    const camp = list.body.items.find(
      (x: { id: string }) => x.id === c.body.campaign_id);
    const d = await call(
      'POST', storeUrl(`/campaigns/${c.body.campaign_id}/dispatch`),
      { cookies: admin, idem: 'v5-cp-2' },
      { expected_version: camp.version });
    expect(d.status).toBe(200);
    expect(d.body.status).toBe('SENT');
    const del = await call(
      'GET', storeUrl(`/campaigns/${c.body.campaign_id}/deliveries`),
      { cookies: admin });
    expect(del.status).toBe(200);
  });

  it('forecast run stores deterministic metrics', async () => {
    const r = await call('POST', storeUrl('/forecasts'),
      { cookies: admin, idem: 'v5-fc-1' }, { horizon_days: 14 });
    expect(r.status).toBe(201);
    expect(r.body.metrics.model_note).toBeTruthy();
    const list = await call('GET', storeUrl('/forecasts'), { cookies: admin });
    expect(list.body.items.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------- platform: operators + tenant stores --------------------------------
describe('platform operators + stores', () => {
  it('operators list/add/remove', async () => {
    const list = await call('GET', '/platform/operators', { cookies: saas });
    expect(list.status).toBe(200);
    expect(list.body.items.find(
      (x: { user_id: string }) => x.user_id === S.users.saas)).toBeTruthy();
    const add = await call('POST', '/platform/operators',
      { cookies: saas, idem: 'v5-op-1' }, {
        user_id: S.users.rival, display_name: '追加オペレータ',
      });
    expect(add.status).toBe(201);
    const del = await call(
      'DELETE', `/platform/operators/${S.users.rival}`,
      { cookies: saas, idem: 'v5-op-2' });
    expect(del.status).toBe(200);
    const self = await call(
      'DELETE', `/platform/operators/${S.users.saas}`, { cookies: saas });
    expect(self.status).toBe(422);
  });

  it('non-operator cannot use platform routes', async () => {
    const r = await call('GET', '/platform/operators', { cookies: admin });
    expect(r.status).toBe(403);
  });

  it('creates a store under the tenant', async () => {
    const r = await call('POST', `/platform/tenants/${S.tenant}/stores`,
      { cookies: saas, idem: 'v5-st-4' }, {
        name: '第二店舗', timezone: 'Asia/Tokyo', currency: 'JPY',
      });
    expect(r.status).toBe(201);
    const list = await call('GET', `/platform/tenants/${S.tenant}/stores`,
      { cookies: saas });
    expect(list.body.items.find(
      (x: { id: string }) => x.id === r.body.store_id)).toBeTruthy();
  });
});
