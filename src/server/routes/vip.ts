// VIP slice: floor maps, tables, bookings, allocation (exclusion constraint),
// dev checkout adapter + signed dev webhook, decisions, move, cancel.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import type { Guc } from '../lib/db.js';
import { withCtx, withSystem } from '../lib/db.js';
import { E } from '../lib/errors.js';
import { uuid, sha256 } from '../lib/crypto.js';
import { audit, emit, idemKey, withReceipt } from '../lib/tx.js';
import {
  requirePersonal, requireOperator, requirePerm, type MemberCtx, type OperatorCtx, gucPersonal, gucOperator,
} from '../lib/ctx.js';

interface Caller { g: Guc; member: MemberCtx; operator?: OperatorCtx }
async function caller(req: FastifyRequest, storeId: string, perm: string, eventId?: string): Promise<Caller> {
  const op = await req.auth.operator().catch((e) => {
    if ((e as { code?: string }).code === 'OPERATOR_CHANGED') throw e;
    return null;
  });
  if (op && (!eventId || op.eventId === eventId) && op.storeId === storeId) {
    const { member } = await requireOperator(req);
    requirePerm(member, perm);
    return { g: gucOperator(op), member, operator: op };
  }
  const { member, personal } = await requirePersonal(req, storeId);
  requirePerm(member, perm);
  return { g: gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId), member };
}

// devpsp: deterministic dev signature. Real PSP = D-05 gated.
const devSign = (ref: string, result: string) =>
  createHmac('sha256', config.snapshotSecret).update(`devpsp:${ref}:${result}`).digest('hex');

export default async function vipRoutes(app: FastifyInstance) {
  // ---- floor inventory ----
  app.post('/stores/:storeId/floor-maps', async (req, reply) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'floor.manage');
    const b = req.body as { layout?: unknown; status?: string };
    if (!b?.layout) throw E.invalid('layout required');
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    const row = await withCtx(g, async (c) => {
      const v = await c.query(
        `SELECT COALESCE(MAX(version),0)+1 AS v FROM nightclub.floor_maps
          WHERE tenant_id=$1 AND store_id=$2`, [member.tenantId, storeId]);
      const ins = await c.query(
        `INSERT INTO nightclub.floor_maps (tenant_id, store_id, version, layout, status)
         VALUES ($1,$2,$3,$4,'PUBLISHED') RETURNING id, version`,
        [member.tenantId, storeId, v.rows[0].v, JSON.stringify(b.layout)]);
      await audit(c, g, {
        action: 'floor.publish', targetType: 'floor_maps', targetId: ins.rows[0].id,
        afterVersion: ins.rows[0].version, traceId: req.traceId,
      });
      return ins.rows[0];
    });
    reply.code(201);
    return { floor_map_id: row.id, version: row.version, trace_id: req.traceId };
  });

  app.get('/stores/:storeId/floor', async (req) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'event.read');
    return withCtx(gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId), async (c) => {
      const fm = await c.query(
        `SELECT id, version, layout FROM nightclub.floor_maps
          WHERE tenant_id=$1 AND store_id=$2 AND status='PUBLISHED'
          ORDER BY version DESC LIMIT 1`, [member.tenantId, storeId]);
      const tables = await c.query(
        `SELECT id, table_code, zone, capacity_min, capacity_max, status, version
           FROM nightclub.venue_tables WHERE tenant_id=$1 AND store_id=$2
          ORDER BY zone, table_code`, [member.tenantId, storeId]);
      return { floor_map: fm.rows[0] ?? null, tables: tables.rows };
    });
  });

  app.post('/stores/:storeId/tables', async (req, reply) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'floor.manage');
    const b = req.body as {
      table_code?: string; zone?: string; capacity_min?: number; capacity_max?: number;
    };
    if (!b?.table_code || !b.zone || !b.capacity_min || !b.capacity_max) {
      throw E.invalid('table_code, zone, capacity_min, capacity_max required');
    }
    if (b.capacity_min > b.capacity_max) throw E.invalid('capacity range');
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    const row = await withCtx(g, async (c) => {
      const ins = await c.query(
        `INSERT INTO nightclub.venue_tables
           (tenant_id, store_id, table_code, zone, capacity_min, capacity_max)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [member.tenantId, storeId, b.table_code, b.zone, b.capacity_min, b.capacity_max]);
      await audit(c, g, {
        action: 'table.create', targetType: 'venue_tables', targetId: ins.rows[0].id,
        changes: b, traceId: req.traceId,
      });
      return ins.rows[0];
    });
    reply.code(201);
    return { table_id: row.id, trace_id: req.traceId };
  });

  // ---- bookings ----
  app.get('/stores/:storeId/events/:eventId/bookings', async (req) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const c0 = await caller(req, storeId, 'booking.read', eventId);
    return withCtx(c0.g, async (c) => {
      const r = await c.query(
        `SELECT b.id, b.version, b.visit_id, b.customer_id, b.party_count,
                b.starts_at, b.ends_at, b.status, b.admission_pricing,
                b.minimum_minor, b.deposit_minor, b.currency, v.reception_name,
                (SELECT array_agg(t.table_code) FROM nightclub.table_allocations ta
                   JOIN nightclub.venue_tables t
                     ON t.tenant_id=ta.tenant_id AND t.store_id=ta.store_id AND t.id=ta.table_id
                  WHERE ta.tenant_id=b.tenant_id AND ta.store_id=b.store_id
                    AND ta.event_id=b.event_id AND ta.booking_id=b.id
                    AND ta.status IN ('HELD','CONFIRMED')) AS tables
           FROM nightclub.bookings b
           LEFT JOIN nightclub.visits v
             ON v.tenant_id=b.tenant_id AND v.store_id=b.store_id
            AND v.event_id=b.event_id AND v.id=b.visit_id
          WHERE b.tenant_id=$1 AND b.store_id=$2 AND b.event_id=$3
          ORDER BY b.starts_at`, [c0.g.tenantId, storeId, eventId]);
      return { items: r.rows };
    });
  });

  app.post('/stores/:storeId/events/:eventId/bookings', async (req, reply) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const c0 = await caller(req, storeId, 'booking.create', eventId);
    const b = req.body as {
      visit_id?: string; customer_id?: string; party_count?: number;
      starts_at?: string; ends_at?: string; admission_pricing?: string;
      minimum_minor?: number; deposit_minor?: number; table_ids?: string[];
      approval_required?: boolean; reception_name?: string;
    };
    if (!b?.party_count || !b.starts_at || !b.ends_at || b.deposit_minor == null
        || b.minimum_minor == null) {
      throw E.invalid('party_count, starts_at, ends_at, minimum_minor, deposit_minor required');
    }
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'booking.create', key: idemKey(req), body: b,
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const status = b.approval_required ? 'APPROVAL_PENDING'
          : (b.deposit_minor! > 0 ? 'HOLD' : 'CONFIRMED');
        const ins = await c.query(
          `INSERT INTO nightclub.bookings
             (tenant_id, store_id, event_id, visit_id, customer_id, party_count,
              starts_at, ends_at, hold_expires_at, status, admission_pricing,
              minimum_minor, deposit_minor, currency, policy_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                   (SELECT currency FROM nightclub.stores WHERE tenant_id=$1 AND id=$2),
                   $14) RETURNING id, version`,
          [g.tenantId, g.storeId, eventId, b.visit_id ?? null, b.customer_id ?? null,
           b.party_count, b.starts_at, b.ends_at,
           status === 'HOLD' ? new Date(Date.now() + 30 * 60_000) : null,
           status, b.admission_pricing ?? 'SEPARATE',
           b.minimum_minor, b.deposit_minor,
           JSON.stringify({ reception_name: b.reception_name ?? null })]);
        const bookingId = ins.rows[0].id as string;
        for (const t of b.table_ids ?? []) {
          try {
            await c.query(
              `INSERT INTO nightclub.table_allocations
                 (tenant_id, store_id, event_id, booking_id, table_id,
                  occupied_during, status)
               VALUES ($1,$2,$3,$4,$5, tstzrange($6,$7,'[)'), 'HELD')`,
              [g.tenantId, g.storeId, eventId, bookingId, t, b.starts_at, b.ends_at]);
          } catch (e) {
            if ((e as { code?: string }).code === '23P01') throw E.tableUnavailable();
            throw e;
          }
        }
        await emit(c, g, {
          eventId, eventType: 'booking.created', aggregateType: 'booking',
          aggregateId: bookingId, aggregateVersion: 1,
          payload: { status }, traceId: req.traceId,
        });
        await audit(c, g, {
          action: 'booking.create', targetType: 'bookings', targetId: bookingId,
          changes: { party_count: b.party_count, deposit_minor: b.deposit_minor },
          traceId: req.traceId,
        });
        return { httpStatus: 201, body: { booking_id: bookingId, status, trace_id: req.traceId } };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  app.post('/stores/:storeId/events/:eventId/bookings/:bookingId/decision', async (req, reply) => {
    const { storeId, eventId, bookingId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const c0 = await caller(req, storeId, 'booking.approve', eventId);
    const b = req.body as { decision?: string; reason?: string; expected_version?: number };
    if (!['APPROVED', 'REJECTED'].includes(b?.decision ?? '')) throw E.invalid('decision');
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'booking.decide', key: idemKey(req), body: { ...b, bookingId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const bk = await c.query(
          `SELECT id, version, status FROM nightclub.bookings
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4 FOR UPDATE`,
          [g.tenantId, g.storeId, eventId, bookingId]);
        if (!bk.rows[0]) throw E.notFound('booking');
        if (bk.rows[0].version !== b.expected_version) throw E.versionConflict(bk.rows[0].version);
        if (bk.rows[0].status !== 'APPROVAL_PENDING') throw E.alreadyDecided();
        const next = b.decision === 'APPROVED' ? 'CONFIRMED' : 'CANCELED';
        await c.query(
          `INSERT INTO nightclub.booking_decisions
             (tenant_id, store_id, event_id, booking_id, booking_version,
              actor_membership_id, decision, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [g.tenantId, g.storeId, eventId, bookingId, bk.rows[0].version,
           c0.member.membershipId, b.decision, b.reason ?? null]);
        await c.query(
          `UPDATE nightclub.bookings SET status=$5, version=version+1,
              updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [g.tenantId, g.storeId, eventId, bookingId, next]);
        if (next === 'CONFIRMED') {
          await c.query(
            `UPDATE nightclub.table_allocations SET status='CONFIRMED',
                version=version+1, updated_at=CURRENT_TIMESTAMP
              WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND booking_id=$4`,
            [g.tenantId, g.storeId, eventId, bookingId]);
        } else {
          await c.query(
            `UPDATE nightclub.table_allocations SET status='RELEASED',
                version=version+1, updated_at=CURRENT_TIMESTAMP
              WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND booking_id=$4`,
            [g.tenantId, g.storeId, eventId, bookingId]);
        }
        await emit(c, g, {
          eventId, eventType: 'booking.decided', aggregateType: 'booking',
          aggregateId: bookingId, aggregateVersion: bk.rows[0].version + 1,
          payload: { decision: b.decision }, traceId: req.traceId,
        });
        await audit(c, g, {
          action: 'booking.decide', targetType: 'bookings', targetId: bookingId,
          changes: { decision: b.decision }, reason: b.reason ?? null,
          traceId: req.traceId,
        });
        return { httpStatus: 200, body: { booking_id: bookingId, status: next, trace_id: req.traceId } };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // Deposit checkout via the dev PSP adapter. Provider-independent contract:
  // returns a checkout_url the client opens; result arrives via webhook only.
  app.post('/stores/:storeId/events/:eventId/bookings/:bookingId/checkout', async (req, reply) => {
    const { storeId, eventId, bookingId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const c0 = await caller(req, storeId, 'payment.create', eventId);
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'booking.checkout', key: idemKey(req), body: { bookingId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const bk = await c.query(
          `SELECT b.id, b.version, b.status, b.deposit_minor, b.currency
             FROM nightclub.bookings b
            WHERE b.tenant_id=$1 AND b.store_id=$2 AND b.event_id=$3 AND b.id=$4
            FOR UPDATE`, [g.tenantId, g.storeId, eventId, bookingId]);
        const row = bk.rows[0];
        if (!row) throw E.notFound('booking');
        if (!['HOLD', 'PAYMENT_PENDING', 'APPROVAL_PENDING'].includes(row.status)) {
          throw E.invalid(`booking ${row.status} not payable`);
        }
        const ref = `devpsp_${uuid()}`;
        const p = await c.query(
          `INSERT INTO nightclub.payments
             (tenant_id, store_id, event_id, recorded_by, operator_session_id,
              order_id, method, purpose, amount_minor, currency, status,
              provider, provider_account, provider_reference, operation_id)
           VALUES ($1,$2,$3,$4,$5,NULL,'PSP','DEPOSIT',$6,$7,'CREATED',
                   'devpsp','dev',$8,$9) RETURNING id`,
          [g.tenantId, g.storeId, eventId, c0.member.membershipId,
           c0.operator?.sessionId ?? null, row.deposit_minor, row.currency,
           ref, uuid()]);
        await c.query(
          `UPDATE nightclub.bookings SET status='PAYMENT_PENDING',
              version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [g.tenantId, g.storeId, eventId, bookingId]);
        await emit(c, g, {
          eventId, eventType: 'booking.checkout_created', aggregateType: 'booking',
          aggregateId: bookingId, aggregateVersion: row.version + 1,
          payload: { payment_id: p.rows[0].id }, traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: {
            checkout_url: `/devpsp/checkout/${ref}`,
            provider: 'devpsp', provider_reference: ref,
            state: 'CREATED', trace_id: req.traceId,
          },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // Dev PSP webhook: signed provider callback -> payment SUCCEEDED ->
  // booking CONFIRMED. Real PSP signature verification is a D-05 gate.
  app.post('/integrations/:provider/webhooks', async (req) => {
    const { provider } = req.params as { provider: string };
    if (provider !== 'devpsp') throw E.notFound('provider');
    const b = req.body as {
      provider_reference?: string; result?: string; signature?: string;
      account?: string;
    };
    if (!b?.provider_reference || !b.result || !b.signature) {
      throw E.invalid('provider_reference, result, signature required');
    }
    const expect = devSign(b.provider_reference, b.result);
    if (expect !== b.signature) throw E.unauthenticated('bad signature');
    // Idempotent: external_event_id unique per provider account.
    return withSystem(async (c) => {
      const seen = await c.query(
        `SELECT id, status FROM nightclub.integration_events
          WHERE provider='devpsp' AND provider_account='dev'
            AND external_event_id=$1`,
        [`${b.provider_reference}:${b.result}`]);
      if (seen.rows[0]) return { accepted: true, duplicate: true };
      const r = await c.query(
        `UPDATE nightclub.payments SET status=$2, version=version+1,
            updated_at=CURRENT_TIMESTAMP
          WHERE provider='devpsp' AND provider_account='dev'
            AND provider_reference=$1 AND status IN ('CREATED','PROCESSING')
          RETURNING tenant_id, store_id, event_id, id, order_id`,
        [b.provider_reference, b.result === 'success' ? 'SUCCEEDED' : 'FAILED']);
      const payment = r.rows[0];
      if (payment && b.result === 'success') {
        await c.query(
          `UPDATE nightclub.bookings SET status='CONFIRMED', version=version+1,
              updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3
              AND status='PAYMENT_PENDING'
              AND id IN (SELECT booking_id FROM nightclub.sales_orders
                          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3
                            AND id=$4)`,
          [payment.tenant_id, payment.store_id, payment.event_id, payment.order_id]);
        // booking-linked payments store order_id NULL; find booking via hold
        await c.query(
          `UPDATE nightclub.table_allocations SET status='CONFIRMED',
              version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND status='HELD'`,
          [payment.tenant_id, payment.store_id, payment.event_id]);
      }
      await c.query(
        `INSERT INTO nightclub.integration_events
           (tenant_id, store_id, provider, provider_account, external_event_id,
            payload_hash, payload, status)
         VALUES ($1,$2,'devpsp','dev',$3,$4,$5,'PROCESSED')`,
        [payment?.tenant_id ?? '00000000-0000-0000-0000-000000000000',
         payment?.store_id ?? '00000000-0000-0000-0000-000000000000',
         `${b.provider_reference}:${b.result}`,
         sha256(JSON.stringify(b)), JSON.stringify(b)]);
      return { accepted: true, duplicate: false };
    });
  });

  app.post('/stores/:storeId/events/:eventId/bookings/:bookingId/move', async (req, reply) => {
    const { storeId, eventId, bookingId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const c0 = await caller(req, storeId, 'booking.manage', eventId);
    const b = req.body as { table_id?: string; starts_at?: string; ends_at?: string; expected_version?: number };
    if (!b?.table_id || !b.starts_at || !b.ends_at) throw E.invalid('table_id, starts_at, ends_at required');
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'booking.move', key: idemKey(req), body: { ...b, bookingId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const bk = await c.query(
          `SELECT id, version, status FROM nightclub.bookings
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4 FOR UPDATE`,
          [g.tenantId, g.storeId, eventId, bookingId]);
        if (!bk.rows[0]) throw E.notFound('booking');
        if (!['HOLD', 'CONFIRMED', 'PAYMENT_PENDING'].includes(bk.rows[0].status)) {
          throw E.invalid(`booking ${bk.rows[0].status}`);
        }
        try {
          await c.query(
            `UPDATE nightclub.table_allocations SET status='RELEASED',
                version=version+1, updated_at=CURRENT_TIMESTAMP
              WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND booking_id=$4`,
            [g.tenantId, g.storeId, eventId, bookingId]);
          await c.query(
            `INSERT INTO nightclub.table_allocations
               (tenant_id, store_id, event_id, booking_id, table_id,
                occupied_during, status)
             VALUES ($1,$2,$3,$4,$5,tstzrange($6,$7,'[)'),
                     (SELECT status FROM nightclub.bookings
                       WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
                       LIMIT 1))`,
            [g.tenantId, g.storeId, eventId, bookingId, b.table_id, b.starts_at, b.ends_at]);
        } catch (e) {
          if ((e as { code?: string }).code === '23P01') throw E.tableUnavailable();
          throw e;
        }
        await audit(c, g, {
          action: 'booking.move', targetType: 'bookings', targetId: bookingId,
          changes: { table_id: b.table_id }, traceId: req.traceId,
        });
        return { httpStatus: 200, body: { booking_id: bookingId, status: bk.rows[0].status, trace_id: req.traceId } };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  app.post('/stores/:storeId/events/:eventId/bookings/:bookingId/cancel', async (req, reply) => {
    const { storeId, eventId, bookingId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const c0 = await caller(req, storeId, 'booking.cancel', eventId);
    const b = (req.body ?? {}) as { expected_version?: number; reason?: string };
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'booking.cancel', key: idemKey(req), body: { ...b, bookingId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const bk = await c.query(
          `SELECT id, version, status FROM nightclub.bookings
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4 FOR UPDATE`,
          [g.tenantId, g.storeId, eventId, bookingId]);
        if (!bk.rows[0]) throw E.notFound('booking');
        if (bk.rows[0].version !== b.expected_version) throw E.versionConflict(bk.rows[0].version);
        if (['CANCELED'].includes(bk.rows[0].status)) throw E.invalid('already canceled');
        await c.query(
          `UPDATE nightclub.bookings SET status='CANCELED', version=version+1,
              updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [g.tenantId, g.storeId, eventId, bookingId]);
        await c.query(
          `UPDATE nightclub.table_allocations SET status='RELEASED',
              version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND booking_id=$4`,
          [g.tenantId, g.storeId, eventId, bookingId]);
        await audit(c, g, {
          action: 'booking.cancel', targetType: 'bookings', targetId: bookingId,
          reason: b.reason ?? null, traceId: req.traceId,
        });
        return { httpStatus: 200, body: { booking_id: bookingId, status: 'CANCELED', trace_id: req.traceId } };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });
}
