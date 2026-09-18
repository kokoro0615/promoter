// R1 finance slice: cash/external-terminal payment recording at the desk,
// refunds (pending-review states), metrics, referrer own-performance.
// PSP checkout is a provider-gated adapter (see integrations.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Guc } from '../lib/db.js';
import { withCtx } from '../lib/db.js';
import { E } from '../lib/errors.js';
import { uuid } from '../lib/crypto.js';
import { audit, emit, idemKey, withReceipt } from '../lib/tx.js';
import {
  body, eventChild, eventParams, int, isoTs, posMinor, query, str,
  uuid as sUuid, version,
} from '../lib/schemas.js';
import { visitSummary } from '../lib/summary.js';
import {
  requirePersonal, requireOperator, requirePerm, type MemberCtx, type OperatorCtx, gucPersonal, gucOperator,
} from '../lib/ctx.js';
import { config } from '../config.js';

interface Caller { g: Guc; member: MemberCtx; operator?: OperatorCtx }

async function caller(req: FastifyRequest, storeId: string, eventId: string | null, perm: string): Promise<Caller> {
  const op = eventId ? await req.auth.operator().catch((e) => {
    if ((e as { code?: string }).code === 'OPERATOR_CHANGED') throw e;
    return null;
  }) : null;
  if (op && eventId) {
    if (op.storeId !== storeId || op.eventId !== eventId) throw E.forbidden('wrong store/event');
    const { member } = await requireOperator(req);
    requirePerm(member, perm);
    return { g: gucOperator(op), member, operator: op };
  }
  const { member, personal } = await requirePersonal(req, storeId);
  requirePerm(member, perm);
  return { g: gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId), member };
}

export default async function financeRoutes(app: FastifyInstance) {
  // Record an entrance payment (cash or external terminal) against a visit's
  // admission order. Money comes in -> SUCCEEDED immediately for CASH;
  // EXTERNAL_TERMINAL is recorded as SUCCEEDED only when the operator
  // confirms the terminal result.
  app.post('/stores/:storeId/events/:eventId/orders', {
    schema: {
      params: eventParams,
      body: body({
        kind: { type: 'string', enum: ['ADMISSION', 'VIP', 'IN_VENUE'] },
        visit_id: sUuid, booking_id: sUuid,
      }),
    },
  }, async (req, reply) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const c0 = await caller(req, storeId, eventId, 'payment.record');
    const b = req.body as { kind?: string; visit_id?: string; booking_id?: string };
    const kind = b?.kind ?? 'ADMISSION';
    if (!['ADMISSION', 'VIP', 'IN_VENUE'].includes(kind)) throw E.invalid('kind');
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'order.create', key: idemKey(req), body: b,
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const ins = await c.query(
          `INSERT INTO nightclub.sales_orders
             (tenant_id, store_id, event_id, kind, visit_id, booking_id, currency, status)
           VALUES ($1,$2,$3,$4,$5,$6,
                   (SELECT currency FROM nightclub.stores WHERE tenant_id=$1 AND id=$2),
                   'DRAFT') RETURNING id`,
          [g.tenantId, g.storeId, eventId, kind, b.visit_id ?? null, b.booking_id ?? null]);
        await audit(c, g, {
          action: 'order.create', targetType: 'sales_orders',
          targetId: ins.rows[0].id, changes: { kind }, traceId: req.traceId,
        });
        return { httpStatus: 201, body: { order_id: ins.rows[0].id, status: 'DRAFT', trace_id: req.traceId } };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  app.get('/stores/:storeId/events/:eventId/orders/:orderId', {
    schema: { params: eventChild('orderId') },
  }, async (req) => {
    const { storeId, eventId, orderId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const c0 = await caller(req, storeId, eventId, 'sales.read');
    return withCtx(c0.g, async (c) => {
      const o = await c.query(
        `SELECT id, kind, visit_id, booking_id, currency, status, version
           FROM nightclub.sales_orders
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
        [c0.g.tenantId, storeId, eventId, orderId]);
      if (!o.rows[0]) throw E.notFound('order');
      const lines = await c.query(
        `SELECT id, category, line_kind, description, quantity, gross_minor, tax_minor, currency
           FROM nightclub.sales_lines
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND order_id=$4`,
        [c0.g.tenantId, storeId, eventId, orderId]);
      const pays = await c.query(
        `SELECT id, method, purpose, amount_minor, currency, status
           FROM nightclub.payments
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND order_id=$4`,
        [c0.g.tenantId, storeId, eventId, orderId]);
      return { order: o.rows[0], lines: lines.rows, payments: pays.rows };
    });
  });

  app.post('/stores/:storeId/events/:eventId/orders/:orderId/payments', {
    schema: {
      params: eventChild('orderId'),
      body: body({
        method: { type: 'string', enum: ['CASH', 'EXTERNAL_TERMINAL'] },
        amount_minor: posMinor,
        purpose: { type: 'string', enum: ['DEPOSIT', 'FINAL', 'ADMISSION'] },
      }, ['method', 'amount_minor']),
    },
  }, async (req, reply) => {
    const { storeId, eventId, orderId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const c0 = await caller(req, storeId, eventId, 'payment.record');
    const b = req.body as { method?: string; amount_minor?: number; purpose?: string };
    if (!b?.method || typeof b.amount_minor !== 'number' || b.amount_minor <= 0) {
      throw E.invalid('method and positive amount_minor required');
    }
    if (!['CASH', 'EXTERNAL_TERMINAL'].includes(b.method)) {
      // PSP money only arrives via the gated checkout/webhook adapter.
      throw E.invalid('method');
    }
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'payment.record', key: idemKey(req), body: { ...b, orderId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const o = await c.query(
          `SELECT id, currency, status FROM nightclub.sales_orders
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4 FOR UPDATE`,
          [g.tenantId, g.storeId, eventId, orderId]);
        if (!o.rows[0]) throw E.notFound('order');
        const p = await c.query(
          `INSERT INTO nightclub.payments
             (tenant_id, store_id, event_id, recorded_by, operator_session_id,
              order_id, method, purpose, amount_minor, currency, status,
              provider, operation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'SUCCEEDED','manual',$11)
           RETURNING id`,
          [g.tenantId, g.storeId, eventId, c0.member.membershipId,
           c0.operator?.sessionId ?? null, orderId, b.method,
           b.purpose ?? 'ADMISSION', b.amount_minor, o.rows[0].currency, uuid()]);
        // Allocate against unpaid SALE lines in order.
        const lines = await c.query(
          `SELECT id, gross_minor FROM nightclub.sales_lines
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND order_id=$4
              AND line_kind='SALE' ORDER BY created_at`,
          [g.tenantId, g.storeId, eventId, orderId]);
        let remaining = b.amount_minor!;
        for (const l of lines.rows) {
          if (remaining <= 0) break;
          const applied = await c.query(
            `SELECT COALESCE(SUM(amount_minor),0)::bigint AS a
               FROM nightclub.payment_allocations
              WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND sales_line_id=$4`,
            [g.tenantId, g.storeId, eventId, l.id]);
          const open = Number(l.gross_minor) - Number(applied.rows[0].a);
          const use = Math.min(open, remaining);
          if (use > 0) {
            await c.query(
              `INSERT INTO nightclub.payment_allocations
                 (tenant_id, store_id, event_id, sales_line_id, payment_id,
                  order_id, amount_minor, currency, operation_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [g.tenantId, g.storeId, eventId, l.id, p.rows[0].id, orderId,
               use, o.rows[0].currency, uuid()]);
            remaining -= use;
          }
        }
        await emit(c, g, {
          eventId, eventType: 'payment.recorded', aggregateType: 'payment',
          aggregateId: p.rows[0].id, aggregateVersion: 1,
          payload: { order_id: orderId, amount_minor: b.amount_minor, method: b.method },
          traceId: req.traceId,
        });
        await audit(c, g, {
          action: 'payment.record', targetType: 'payments',
          targetId: p.rows[0].id,
          changes: { order_id: orderId, amount_minor: b.amount_minor, method: b.method },
          traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: { payment_id: p.rows[0].id, status: 'SUCCEEDED', trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // Refund request -> pending review. Pending refunds reduce available funds.
  app.post('/stores/:storeId/events/:eventId/payments/:paymentId/refunds', {
    schema: {
      params: eventChild('paymentId'),
      body: body({ amount_minor: posMinor, reason: str(1000) },
        ['amount_minor', 'reason']),
    },
  }, async (req, reply) => {
    const { storeId, eventId, paymentId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const c0 = await caller(req, storeId, eventId, 'payment.refund');
    const b = req.body as { amount_minor?: number; reason?: string };
    if (typeof b?.amount_minor !== 'number' || b.amount_minor <= 0 || !b.reason) {
      throw E.invalid('amount_minor and reason required');
    }
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'refund.create', key: idemKey(req), body: { ...b, paymentId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const p = await c.query(
          `SELECT id, amount_minor, currency, status, method FROM nightclub.payments
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4 FOR UPDATE`,
          [g.tenantId, g.storeId, eventId, paymentId]);
        const pay = p.rows[0];
        if (!pay) throw E.notFound('payment');
        if (!['SUCCEEDED', 'PARTIAL_REFUND'].includes(pay.status)) {
          throw E.invalid(`payment ${pay.status} not refundable`);
        }
        const used = await c.query(
          `SELECT COALESCE(SUM(amount_minor),0)::bigint AS r
             FROM nightclub.refunds
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND payment_id=$4
              AND status IN ('REQUESTED','PROCESSING','SUCCEEDED')`,
          [g.tenantId, g.storeId, eventId, paymentId]);
        if (Number(used.rows[0].r) + b.amount_minor! > Number(pay.amount_minor)) {
          throw E.invalid('refund exceeds refundable amount');
        }
        const r = await c.query(
          `INSERT INTO nightclub.refunds
             (tenant_id, store_id, event_id, payment_id, amount_minor, currency,
              status, reason, requested_by, operation_id)
           VALUES ($1,$2,$3,$4,$5,$6,'REQUESTED',$7,$8,$9) RETURNING id`,
          [g.tenantId, g.storeId, eventId, paymentId, b.amount_minor,
           pay.currency, b.reason, c0.member.membershipId, uuid()]);
        await emit(c, g, {
          eventId, eventType: 'refund.requested', aggregateType: 'refund',
          aggregateId: r.rows[0].id, aggregateVersion: 1,
          payload: { payment_id: paymentId, amount_minor: b.amount_minor },
          traceId: req.traceId,
        });
        await audit(c, g, {
          action: 'refund.request', targetType: 'refunds', targetId: r.rows[0].id,
          changes: { payment_id: paymentId, amount_minor: b.amount_minor },
          reason: b.reason ?? null, traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: { refund_id: r.rows[0].id, status: 'REQUESTED', trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // Refund approval/execution (money permissions; REQUESTED -> SUCCEEDED).
  app.post('/stores/:storeId/events/:eventId/refunds/:refundId/execute', {
    schema: {
      params: eventChild('refundId'),
      body: body({ expected_version: version }),
    },
  }, async (req, reply) => {
    const { storeId, eventId, refundId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const c0 = await caller(req, storeId, eventId, 'payment.refund');
    const b = (req.body ?? {}) as { expected_version?: number };
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'refund.execute', key: idemKey(req), body: { ...b, refundId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const r = await c.query(
          `SELECT id, version, status, payment_id, amount_minor FROM nightclub.refunds
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4 FOR UPDATE`,
          [g.tenantId, g.storeId, eventId, refundId]);
        const rf = r.rows[0];
        if (!rf) throw E.notFound('refund');
        if (rf.status !== 'REQUESTED') throw E.invalid(`refund ${rf.status}`);
        if (rf.version !== b.expected_version) throw E.versionConflict(rf.version);
        // CASH/EXTERNAL refunds are settled at the desk; PSP refunds go
        // through the adapter (not invoked here).
        await c.query(
          `UPDATE nightclub.refunds SET status='SUCCEEDED', version=version+1,
              updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [g.tenantId, g.storeId, eventId, refundId]);
        const p = await c.query(
          `UPDATE nightclub.payments SET
              status = CASE WHEN (SELECT COALESCE(SUM(amount_minor),0)
                                    FROM nightclub.refunds
                                   WHERE tenant_id=$1 AND store_id=$2
                                     AND event_id=$3 AND payment_id=$4
                                     AND status='SUCCEEDED') >= amount_minor
                            THEN 'REFUNDED' ELSE 'PARTIAL_REFUND' END,
              version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
            RETURNING status`,
          [g.tenantId, g.storeId, eventId, rf.payment_id]);
        await emit(c, g, {
          eventId, eventType: 'refund.succeeded', aggregateType: 'refund',
          aggregateId: refundId, aggregateVersion: rf.version + 1,
          payload: { payment_id: rf.payment_id, payment_status: p.rows[0].status },
          traceId: req.traceId,
        });
        await audit(c, g, {
          action: 'refund.execute', targetType: 'refunds', targetId: refundId,
          traceId: req.traceId,
        });
        return { httpStatus: 200, body: { refund_id: refundId, status: 'SUCCEEDED', trace_id: req.traceId } };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // Event metrics.
  app.get('/stores/:storeId/events/:eventId/metrics', {
    schema: { params: eventParams },
  }, async (req) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const c0 = await caller(req, storeId, eventId, 'event.read');
    return withCtx(c0.g, async (c) => {
      const m = await c.query(
        `SELECT
           COALESCE(SUM(first_entry_delta),0)::bigint AS first_entries,
           COALESCE(SUM(present_delta),0)::bigint AS present
         FROM nightclub.admission_events
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3`,
        [c0.g.tenantId, storeId, eventId]);
      const sales = await c.query(
        `SELECT category, COALESCE(SUM(gross_minor),0)::bigint AS gross
           FROM nightclub.sales_lines
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND line_kind='SALE'
          GROUP BY category`,
        [c0.g.tenantId, storeId, eventId]);
      const byCat = Object.fromEntries(sales.rows.map((r) => [r.category, Number(r.gross)]));
      const st = await c.query(
        `SELECT currency FROM nightclub.stores WHERE tenant_id=$1 AND id=$2`,
        [c0.g.tenantId, storeId]);
      return {
        event_id: eventId,
        first_entries: Number(m.rows[0].first_entries),
        present_count: Number(m.rows[0].present),
        present_is_estimate: false,
        admission_sales_minor: byCat.ADMISSION ?? 0,
        vip_sales_minor: (byCat.VIP ?? 0) - (byCat.CANCELLATION ?? 0),
        in_venue_sales_minor: byCat.IN_VENUE ?? null,
        currency: st.rows[0].currency,
        provisional: false,
      };
    });
  });

  // Referrer own performance (own-scope only).
  app.get('/stores/:storeId/events/:eventId/my-performance', {
    schema: { params: eventParams },
  }, async (req) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const c0 = await caller(req, storeId, eventId, 'report.own');
    return withCtx(c0.g, async (c) => {
      const r = await c.query(
        `SELECT count(DISTINCT v.id)::int AS visits,
                COALESCE(SUM(ae.first_entry_delta),0)::bigint AS first_entries,
                COALESCE(SUM(CASE WHEN ae.kind='FIRST_ENTRY' THEN ae.quantity ELSE 0 END),0)::bigint AS entries
           FROM nightclub.visits v
           LEFT JOIN nightclub.admission_events ae
             ON ae.tenant_id=v.tenant_id AND ae.store_id=v.store_id
            AND ae.event_id=v.event_id AND ae.visit_id=v.id
          WHERE v.tenant_id=$1 AND v.store_id=$2 AND v.event_id=$3
            AND v.referrer_membership_id=$4`,
        [c0.g.tenantId, storeId, eventId, c0.member.membershipId]);
      const sales = await c.query(
        `SELECT COALESCE(SUM(sl.gross_minor),0)::bigint AS gross
           FROM nightclub.sales_attributions sa
           JOIN nightclub.sales_lines sl
             ON sl.tenant_id=sa.tenant_id AND sl.store_id=sa.store_id
            AND sl.event_id=sa.event_id AND sl.id=sa.sales_line_id
          WHERE sa.tenant_id=$1 AND sa.store_id=$2 AND sa.event_id=$3
            AND sa.referrer_membership_id=$4`,
        [c0.g.tenantId, storeId, eventId, c0.member.membershipId]);
      return {
        membership_id: c0.member.membershipId,
        visits: r.rows[0].visits,
        first_entries: Number(r.rows[0].first_entries),
        sales_minor: Number(sales.rows[0].gross),
        currency: 'JPY',
      };
    });
  });

  // ---- orders list (F-014) ---------------------------------------------------
  app.get('/stores/:storeId/events/:eventId/orders', {
    schema: {
      params: eventParams,
      querystring: query({
        kind: { type: 'string', enum: ['ADMISSION', 'VIP', 'IN_VENUE', 'TICKET', 'POS'] },
        status: { type: 'string', enum: ['DRAFT', 'FINALIZED', 'ADJUSTED', 'VOID'] },
      }),
    },
  }, async (req) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string };
    const c0 = await caller(req, storeId, eventId, 'sales.read');
    const q = req.query as { kind?: string; status?: string };
    return withCtx(c0.g, async (c) => {
      const r = await c.query(
        `SELECT o.id, o.kind, o.visit_id, o.booking_id, o.currency, o.status,
                o.version, o.created_at,
                COALESCE((SELECT SUM(l.gross_minor) FROM nightclub.sales_lines l
                   WHERE l.tenant_id=o.tenant_id AND l.store_id=o.store_id
                     AND l.event_id=o.event_id AND l.order_id=o.id
                     AND l.line_kind='SALE'),0)::bigint AS gross_minor,
                COALESCE((SELECT SUM(l.gross_minor) FROM nightclub.sales_lines l
                   WHERE l.tenant_id=o.tenant_id AND l.store_id=o.store_id
                     AND l.event_id=o.event_id AND l.order_id=o.id
                     AND l.line_kind='CREDIT'),0)::bigint AS credit_minor,
                (SELECT COALESCE(SUM(p.amount_minor),0)::bigint
                   FROM nightclub.payments p
                  WHERE p.tenant_id=o.tenant_id AND p.store_id=o.store_id
                    AND p.event_id=o.event_id AND p.order_id=o.id
                    AND p.status IN ('SUCCEEDED','PARTIAL_REFUND')) AS paid_minor
           FROM nightclub.sales_orders o
          WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.event_id=$3
            AND ($4::text IS NULL OR o.kind=$4)
            AND ($5::text IS NULL OR o.status=$5)
          ORDER BY o.created_at DESC`,
        [c0.g.tenantId, storeId, eventId, q.kind ?? null, q.status ?? null]);
      return { items: r.rows };
    });
  });

  // ---- reward lifecycle (F-025): statements, disputes, payout records -------
  // Statements = settlement_lines grouped per referrer. reward.manage sees
  // all referrers; report.own sees only the caller's own lines.
  app.get('/stores/:storeId/events/:eventId/reward-statements', {
    schema: {
      params: eventParams,
      querystring: query({ referrer_membership_id: sUuid }),
    },
  }, async (req) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string };
    const c0 = await caller(req, storeId, eventId, 'event.read');
    const q = req.query as { referrer_membership_id?: string };
    const manageAll = c0.member.permissions.has('reward.manage');
    if (!manageAll && !c0.member.permissions.has('report.own')) {
      throw E.forbidden('reward.manage or report.own required');
    }
    const referrer = manageAll
      ? (q.referrer_membership_id ?? null)
      : c0.member.membershipId;
    return withCtx(c0.g, async (c) => {
      const r = await c.query(
        `SELECT sl.referrer_membership_id, m.display_name AS referrer_name,
                s.id AS settlement_id, s.status AS settlement_status,
                s.version AS settlement_version, s.finalized_at,
                sl.currency,
                SUM(sl.amount_minor)::bigint AS amount_minor,
                count(*)::int AS line_count,
                COALESCE((SELECT SUM(a.amount_minor)
                   FROM nightclub.reward_adjustments a
                  JOIN nightclub.settlement_lines x
                    ON x.tenant_id=a.tenant_id AND x.store_id=a.store_id
                   AND x.event_id=a.event_id AND x.id=a.settlement_line_id
                  WHERE x.settlement_id=s.id),0)::bigint AS adjustments_minor
           FROM nightclub.settlement_lines sl
           JOIN nightclub.settlements s
             ON s.tenant_id=sl.tenant_id AND s.store_id=sl.store_id
            AND s.event_id=sl.event_id AND s.id=sl.settlement_id
           JOIN nightclub.memberships m
             ON m.tenant_id=sl.tenant_id AND m.store_id=sl.store_id
            AND m.id=sl.referrer_membership_id
          WHERE sl.tenant_id=$1 AND sl.store_id=$2 AND sl.event_id=$3
            AND ($4::uuid IS NULL OR sl.referrer_membership_id=$4)
          GROUP BY sl.referrer_membership_id, m.display_name,
                   s.id, s.status, s.version, s.finalized_at, sl.currency
          ORDER BY sl.referrer_membership_id`,
        [c0.g.tenantId, storeId, eventId, referrer]);
      const lines = await c.query(
        `SELECT sl.id, sl.settlement_id, sl.referrer_membership_id,
                sl.reward_rule_id, sl.amount_minor, sl.currency,
                sl.calculation, sl.source_key, sl.created_at
           FROM nightclub.settlement_lines sl
          WHERE sl.tenant_id=$1 AND sl.store_id=$2 AND sl.event_id=$3
            AND ($4::uuid IS NULL OR sl.referrer_membership_id=$4)
          ORDER BY sl.created_at`,
        [c0.g.tenantId, storeId, eventId, referrer]);
      return { statements: r.rows, lines: lines.rows };
    });
  });

  app.post('/stores/:storeId/events/:eventId/reward-disputes', {
    schema: {
      params: eventParams,
      body: body({
        settlement_line_id: sUuid, reason: str(1000),
      }, ['settlement_line_id', 'reason']),
    },
  }, async (req, reply) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string };
    const c0 = await caller(req, storeId, eventId, 'event.read');
    const manageAll = c0.member.permissions.has('reward.manage');
    if (!manageAll && !c0.member.permissions.has('report.own')) {
      throw E.forbidden('reward.manage or report.own required');
    }
    const b = req.body as { settlement_line_id?: string; reason?: string };
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'reward_dispute.raise', key: idemKey(req), body: b,
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const sl = await c.query(
          `SELECT id, referrer_membership_id FROM nightclub.settlement_lines
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [g.tenantId, g.storeId, eventId, b.settlement_line_id]);
        const line = sl.rows[0];
        if (!line) throw E.notFound('settlement line');
        if (!manageAll && line.referrer_membership_id !== c0.member.membershipId) {
          throw E.forbidden('can only dispute own reward lines');
        }
        const ins = await c.query(
          `INSERT INTO nightclub.reward_disputes
             (tenant_id, store_id, event_id, settlement_line_id,
              raised_by, reason)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [g.tenantId, g.storeId, eventId, b.settlement_line_id,
           c0.member.membershipId, b.reason]);
        await audit(c, g, {
          action: 'reward_dispute.raise', targetType: 'reward_disputes',
          targetId: ins.rows[0].id, reason: b.reason ?? null,
          traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: { dispute_id: ins.rows[0].id, status: 'OPEN', trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  app.get('/stores/:storeId/events/:eventId/reward-disputes', {
    schema: {
      params: eventParams,
      querystring: query({
        status: { type: 'string', enum: ['OPEN', 'RESOLVED', 'REJECTED'] },
      }),
    },
  }, async (req) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string };
    const c0 = await caller(req, storeId, eventId, 'event.read');
    const manageAll = c0.member.permissions.has('reward.manage');
    if (!manageAll && !c0.member.permissions.has('report.own')) {
      throw E.forbidden('reward.manage or report.own required');
    }
    const q = req.query as { status?: string };
    return withCtx(c0.g, async (c) => {
      const r = await c.query(
        `SELECT d.id, d.settlement_line_id, d.raised_by, d.reason, d.status,
                d.resolution, d.version, d.created_at, d.updated_at,
                sl.referrer_membership_id, sl.amount_minor, sl.currency
           FROM nightclub.reward_disputes d
           JOIN nightclub.settlement_lines sl
             ON sl.tenant_id=d.tenant_id AND sl.store_id=d.store_id
            AND sl.event_id=d.event_id AND sl.id=d.settlement_line_id
          WHERE d.tenant_id=$1 AND d.store_id=$2 AND d.event_id=$3
            AND ($4::text IS NULL OR d.status=$4)
            AND ($5::boolean OR d.raised_by=$6 OR sl.referrer_membership_id=$6)
          ORDER BY d.created_at`,
        [c0.g.tenantId, storeId, eventId, q.status ?? null,
         manageAll, c0.member.membershipId]);
      return { items: r.rows };
    });
  });

  // Resolve: reward.manage only. Optional adjustment posts a signed
  // reward_adjustments row against the disputed line (append-only audit).
  app.post('/stores/:storeId/events/:eventId/reward-disputes/:disputeId/resolve', {
    schema: {
      params: eventChild('disputeId'),
      body: body({
        expected_version: version,
        status: { type: 'string', enum: ['RESOLVED', 'REJECTED'] },
        resolution: str(1000), adjustment_minor: int,
      }, ['expected_version', 'status', 'resolution']),
    },
  }, async (req, reply) => {
    const { storeId, eventId, disputeId } = req.params as {
      storeId: string; eventId: string; disputeId: string;
    };
    const c0 = await caller(req, storeId, eventId, 'reward.manage');
    const b = req.body as {
      expected_version?: number; status?: string;
      resolution?: string; adjustment_minor?: number;
    };
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'reward_dispute.resolve', key: idemKey(req),
      body: { ...b, disputeId }, receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const d = await c.query(
          `SELECT id, status, version, settlement_line_id
             FROM nightclub.reward_disputes
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
            FOR UPDATE`, [g.tenantId, g.storeId, eventId, disputeId]);
        const dis = d.rows[0];
        if (!dis) throw E.notFound('dispute');
        if (dis.status !== 'OPEN') throw E.alreadyDecided();
        if (dis.version !== b.expected_version) {
          throw E.versionConflict(dis.version);
        }
        await c.query(
          `UPDATE nightclub.reward_disputes SET status=$5, resolution=$6,
              version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [g.tenantId, g.storeId, eventId, disputeId, b.status, b.resolution]);
        if (b.status === 'RESOLVED' && b.adjustment_minor) {
          await c.query(
            `INSERT INTO nightclub.reward_adjustments
               (tenant_id, store_id, event_id, settlement_line_id,
                amount_minor, reason, created_by, operation_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [g.tenantId, g.storeId, eventId, dis.settlement_line_id,
             b.adjustment_minor, `dispute:${disputeId} ${b.resolution}`,
             c0.member.membershipId, uuid()]);
        }
        await audit(c, g, {
          action: 'reward_dispute.resolve', targetType: 'reward_disputes',
          targetId: disputeId, changes: { status: b.status },
          reason: b.resolution ?? null, traceId: req.traceId,
        });
        return {
          httpStatus: 200,
          body: { dispute_id: disputeId, status: b.status, trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // External payout record (bank transfer evidence — never executes money).
  app.post('/stores/:storeId/events/:eventId/settlement-payments', {
    schema: {
      params: eventParams,
      body: body({
        settlement_id: sUuid, referrer_membership_id: sUuid,
        amount_minor: posMinor, external_reference: str(200), paid_at: isoTs,
      }, ['settlement_id', 'referrer_membership_id', 'amount_minor',
          'external_reference', 'paid_at']),
    },
  }, async (req, reply) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string };
    const c0 = await caller(req, storeId, eventId, 'settlement.manage');
    const b = req.body as {
      settlement_id?: string; referrer_membership_id?: string;
      amount_minor?: number; external_reference?: string; paid_at?: string;
    };
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'settlement_payment.record', key: idemKey(req), body: b,
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const s = await c.query(
          `SELECT id, status FROM nightclub.settlements
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [g.tenantId, g.storeId, eventId, b.settlement_id]);
        if (!s.rows[0]) throw E.notFound('settlement');
        if (s.rows[0].status !== 'FINALIZED') {
          throw E.invalid('payout requires a FINALIZED settlement');
        }
        const st = await c.query(
          `SELECT currency FROM nightclub.stores WHERE tenant_id=$1 AND id=$2`,
          [g.tenantId, g.storeId]);
        const ins = await c.query(
          `INSERT INTO nightclub.settlement_payments
             (tenant_id, store_id, event_id, settlement_id,
              referrer_membership_id, amount_minor, currency,
              external_reference, recorded_by, paid_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [g.tenantId, g.storeId, eventId, b.settlement_id,
           b.referrer_membership_id, b.amount_minor, st.rows[0].currency,
           b.external_reference, c0.member.membershipId, b.paid_at]);
        await audit(c, g, {
          action: 'settlement_payment.record',
          targetType: 'settlement_payments', targetId: ins.rows[0].id,
          changes: b, traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: { settlement_payment_id: ins.rows[0].id, trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  app.get('/stores/:storeId/events/:eventId/settlement-payments', {
    schema: { params: eventParams },
  }, async (req) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string };
    const c0 = await caller(req, storeId, eventId, 'settlement.manage');
    return withCtx(c0.g, async (c) => ({
      items: (await c.query(
        `SELECT sp.id, sp.settlement_id, sp.referrer_membership_id,
                m.display_name AS referrer_name, sp.amount_minor, sp.currency,
                sp.external_reference, sp.paid_at, sp.created_at
           FROM nightclub.settlement_payments sp
           JOIN nightclub.memberships m
             ON m.tenant_id=sp.tenant_id AND m.store_id=sp.store_id
            AND m.id=sp.referrer_membership_id
          WHERE sp.tenant_id=$1 AND sp.store_id=$2 AND sp.event_id=$3
          ORDER BY sp.paid_at`,
        [c0.g.tenantId, storeId, eventId])).rows,
    }));
  });
}
