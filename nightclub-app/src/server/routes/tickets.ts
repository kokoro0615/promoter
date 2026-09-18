// EP26 (R3): advance ticket sales + QR redemption at the entrance.
// Invariants: per-product quantity limit enforced under row lock; tokens are
// stored hashed; a ticket redeems exactly once (status transition under
// FOR UPDATE); redemption creates a real visit + AUTHORIZED segment +
// FIRST_ENTRY ledger event + group pass, like a normal entry.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Guc, Client } from '../lib/db.js';
import { withCtx } from '../lib/db.js';
import { E } from '../lib/errors.js';
import { nameKey } from '../lib/namekey.js';
import { uuid, sha256, randomToken } from '../lib/crypto.js';
import { audit, emit, idemKey, withReceipt } from '../lib/tx.js';
import {
  body, eventChild, eventParams, isoTs, minor, str,
  uuid as sUuid, version,
} from '../lib/schemas.js';
import { visitSummary } from '../lib/summary.js';
import {
  requirePersonal, requireOperator, requirePerm,
  type MemberCtx, type OperatorCtx, type PersonalCtx, gucPersonal, gucOperator,
} from '../lib/ctx.js';
import { config } from '../config.js';

interface Caller {
  g: Guc; member: MemberCtx;
  operator?: OperatorCtx; personal?: PersonalCtx;
}

async function caller(
  req: FastifyRequest, storeId: string, eventId: string | null, perm: string,
): Promise<Caller> {
  const op = await req.auth.operator().catch(() => null);
  if (op) {
    if (op.storeId !== storeId || (eventId && op.eventId !== eventId)) {
      throw E.forbidden('wrong store/event');
    }
    const { member } = await requireOperator(req);
    requirePerm(member, perm);
    return { g: gucOperator(op), member, operator: op };
  }
  const { member, personal } = await requirePersonal(req, storeId);
  requirePerm(member, perm);
  return {
    g: gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
    member, personal,
  };
}

type P = {
  storeId: string; eventId: string; productId: string; orderId: string;
  ticketId: string;
};

export default async function ticketRoutes(app: FastifyInstance) {
  // ---- ticket products ----------------------------------------------------
  app.post('/stores/:storeId/events/:eventId/ticket-products', {
    schema: {
      params: eventParams,
      body: body({
        code: str(64), name: str(200), price_minor: minor,
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
        sales_from: isoTs, sales_to: isoTs,
        quantity_limit: { type: ['integer', 'null'], minimum: 1 },
        per_order_limit: { type: 'integer', minimum: 1, maximum: 100 },
      }, ['code', 'name', 'price_minor', 'sales_from', 'sales_to']),
    },
  }, async (req, reply) => {
    const { storeId, eventId } = req.params as P;
    const c0 = await caller(req, storeId, eventId, 'event.manage');
    const b = req.body as {
      code?: string; name?: string; price_minor?: number; currency?: string;
      sales_from?: string; sales_to?: string; quantity_limit?: number | null;
      per_order_limit?: number;
    };
    if (!b?.code || !b.name || typeof b.price_minor !== 'number' || b.price_minor < 0
        || !b.sales_from || !b.sales_to) {
      throw E.invalid('code, name, price_minor, sales window required');
    }
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'ticket_product.create', key: idemKey(req), body: b,
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const r = await c.query(
          `INSERT INTO nightclub.ticket_products
             (tenant_id, store_id, event_id, code, name, price_minor, currency,
              sales_from, sales_to, quantity_limit, per_order_limit)
           VALUES ($1,$2,$3,$4,$5,$6,
                   COALESCE($7,(SELECT currency FROM nightclub.stores
                                 WHERE tenant_id=$1 AND id=$2)),
                   $8,$9,$10,$11) RETURNING id`,
          [g.tenantId, storeId, eventId, b.code, b.name, b.price_minor,
           b.currency ?? null, b.sales_from, b.sales_to,
           b.quantity_limit ?? null, b.per_order_limit ?? 4]);
        await audit(c, g, {
          action: 'ticket_product.create', targetType: 'ticket_products',
          targetId: r.rows[0].id, changes: b, traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: { ticket_product_id: r.rows[0].id, trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  app.get('/stores/:storeId/events/:eventId/ticket-products', {
    schema: { params: eventParams },
  }, async (req) => {
    const { storeId, eventId } = req.params as P;
    const c0 = await caller(req, storeId, eventId, 'event.read');
    return withCtx(c0.g, async (c) => {
      const r = await c.query(
        `SELECT tp.id, tp.code, tp.name, tp.price_minor, tp.currency,
                tp.sales_from, tp.sales_to, tp.quantity_limit, tp.per_order_limit,
                tp.status, tp.version,
                (SELECT count(*)::int FROM nightclub.ticket_instances ti
                  WHERE ti.tenant_id=tp.tenant_id AND ti.store_id=tp.store_id
                    AND ti.product_id=tp.id AND ti.status IN ('ISSUED','REDEEMED')) AS sold
           FROM nightclub.ticket_products tp
          WHERE tp.tenant_id=$1 AND tp.store_id=$2 AND tp.event_id=$3
          ORDER BY tp.code`,
        [c0.g.tenantId, storeId, eventId]);
      return { items: r.rows };
    });
  });

  // ---- purchase --------------------------------------------------------------
  // Staff-assisted or member purchase. Payment methods: CASH / EXTERNAL_TERMINAL
  // record immediately; PSP requires the provider webhook (dev: not wired).
  app.post('/stores/:storeId/events/:eventId/ticket-orders', {
    schema: {
      params: eventParams,
      body: body({
        product_id: sUuid, quantity: { type: 'integer', minimum: 1, maximum: 100 },
        buyer_name: str(200), customer_id: { type: ['string', 'null'], format: 'uuid' },
        method: { type: 'string', enum: ['CASH', 'EXTERNAL_TERMINAL'] },
      }, ['product_id', 'quantity', 'buyer_name', 'method']),
    },
  }, async (req, reply) => {
    const { storeId, eventId } = req.params as P;
    const c0 = await caller(req, storeId, eventId, 'payment.create');
    const b = req.body as {
      product_id?: string; quantity?: number; buyer_name?: string;
      customer_id?: string | null; method?: string;
    };
    if (!b?.product_id || typeof b.quantity !== 'number' || b.quantity <= 0
        || !b.buyer_name || !b.method) {
      throw E.invalid('product_id, quantity, buyer_name, method required');
    }
    if (!['CASH', 'EXTERNAL_TERMINAL'].includes(b.method)) {
      throw E.invalid('method must be CASH or EXTERNAL_TERMINAL (PSP pending B-01)');
    }
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'ticket_order.create', key: idemKey(req), body: b,
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const pr = await c.query(
          `SELECT * FROM nightclub.ticket_products
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
            FOR UPDATE`,
          [g.tenantId, g.storeId, eventId, b.product_id]);
        const prod = pr.rows[0];
        if (!prod || prod.status !== 'ON_SALE') throw E.invalid('product not on sale');
        const now = new Date();
        if (now < new Date(prod.sales_from) || now > new Date(prod.sales_to)) {
          throw E.invalid('outside sales window');
        }
        if (b.quantity! > prod.per_order_limit) {
          throw E.validation('quantity exceeds per-order limit', [{
            path: 'quantity', code: 'PER_ORDER_LIMIT',
            message: `limit ${prod.per_order_limit}`,
          }]);
        }
        const sold = await c.query(
          `SELECT count(*)::int AS n FROM nightclub.ticket_instances
            WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3
              AND status IN ('ISSUED','REDEEMED')`,
          [g.tenantId, g.storeId, b.product_id]);
        if (prod.quantity_limit !== null
            && sold.rows[0].n + b.quantity! > prod.quantity_limit) {
          throw E.quotaExceeded();
        }
        // order + payment + instances
        const amount = b.quantity! * Number(prod.price_minor);
        const ord = await c.query(
          `INSERT INTO nightclub.ticket_orders
             (tenant_id, store_id, event_id, product_id, buyer_membership_id,
              buyer_customer_id, buyer_name, quantity, amount_minor, currency)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [g.tenantId, g.storeId, eventId, b.product_id,
           c0.member.membershipId, b.customer_id ?? null, b.buyer_name,
           b.quantity, amount, prod.currency]);
        const orderId = ord.rows[0].id as string;
        // sales order (kind TICKET) + line + payment row
        const so = await c.query(
          `INSERT INTO nightclub.sales_orders
             (tenant_id, store_id, event_id, kind, visit_id, currency, status)
           VALUES ($1,$2,$3,'TICKET',NULL,$4,'FINALIZED') RETURNING id`,
          [g.tenantId, g.storeId, eventId, prod.currency]);
        await c.query(
          `INSERT INTO nightclub.sales_lines
             (tenant_id, store_id, event_id, order_id, category, line_kind,
              description, quantity, gross_minor, tax_minor, currency, source_key)
           VALUES ($1,$2,$3,$4,'TICKET','SALE',$5,$6,$7,0,$8,$9)`,
          [g.tenantId, g.storeId, eventId, so.rows[0].id,
           `${prod.code} ${prod.name}`, b.quantity, amount, prod.currency,
           `ticket_order:${orderId}`]);
        const opId = uuid();
        const pay = await c.query(
          `INSERT INTO nightclub.payments
             (tenant_id, store_id, event_id, recorded_by, operator_session_id,
              order_id, method, purpose, amount_minor, currency, status,
              operation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'TICKET',$8,$9,'SUCCEEDED',$10)
           RETURNING id`,
          [g.tenantId, g.storeId, eventId, c0.member.membershipId,
           c0.operator?.sessionId ?? null, so.rows[0].id, b.method,
           amount, prod.currency, opId]);
        await c.query(
          `UPDATE nightclub.ticket_orders SET payment_id=$4, version=version+1,
              updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
          [g.tenantId, g.storeId, orderId, pay.rows[0].id]);
        const tokens: { ticket_id: string; token: string }[] = [];
        for (let i = 0; i < b.quantity!; i++) {
          const token = randomToken();
          const ti = await c.query(
            `INSERT INTO nightclub.ticket_instances
               (tenant_id, store_id, event_id, order_id, product_id, token_hash)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [g.tenantId, g.storeId, eventId, orderId, b.product_id, sha256(token)]);
          tokens.push({ ticket_id: ti.rows[0].id, token });
        }
        await emit(c, g, {
          eventId, eventType: 'ticket.sold', aggregateType: 'ticket_order',
          aggregateId: orderId, aggregateVersion: 1,
          payload: { product_id: b.product_id, quantity: b.quantity },
          traceId: req.traceId,
        });
        await audit(c, g, {
          action: 'ticket_order.create', targetType: 'ticket_orders',
          targetId: orderId, changes: { product_id: b.product_id, quantity: b.quantity },
          traceId: req.traceId,
        });
        // Tokens are returned exactly once; only hashes persist.
        return {
          httpStatus: 201,
          body: {
            ticket_order_id: orderId, payment_id: pay.rows[0].id,
            amount_minor: amount, currency: prod.currency, tickets: tokens,
            trace_id: req.traceId,
          },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  app.get('/stores/:storeId/events/:eventId/ticket-orders/:orderId', {
    schema: { params: eventChild('orderId') },
  }, async (req) => {
    const { storeId, eventId, orderId } = req.params as P;
    const c0 = await caller(req, storeId, eventId, 'sales.read');
    return withCtx(c0.g, async (c) => {
      const o = await c.query(
        `SELECT id, product_id, buyer_name, quantity, amount_minor, currency,
                status, payment_id, version
           FROM nightclub.ticket_orders
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
        [c0.g.tenantId, storeId, eventId, orderId]);
      if (!o.rows[0]) throw E.notFound('ticket order');
      const t = await c.query(
        `SELECT id, status, redeemed_at, redeemed_visit_id
           FROM nightclub.ticket_instances
          WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY created_at`,
        [c0.g.tenantId, storeId, orderId]);
      return { order: o.rows[0], tickets: t.rows };
    });
  });

  // Cancel: void un-redeemed instances + refund row for the payment.
  app.post('/stores/:storeId/events/:eventId/ticket-orders/:orderId/cancel', {
    schema: {
      params: eventChild('orderId'),
      body: body({ expected_version: version, reason: str(1000) },
        ['expected_version']),
    },
  },
    async (req, reply) => {
      const { storeId, eventId, orderId } = req.params as P;
      const c0 = await caller(req, storeId, eventId, 'payment.refund');
      const b = (req.body ?? {}) as { expected_version?: number; reason?: string };
      if (typeof b.expected_version !== 'number') throw E.invalid('expected_version required');
      const g = c0.g;
      const res = await withCtx(g, async (c) => withReceipt(c, g, {
        actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
        operation: 'ticket_order.cancel', key: idemKey(req),
        body: { ...b, orderId }, receiptTtlSec: config.ttl.receiptSec,
        run: async () => {
          const o = await c.query(
            `SELECT * FROM nightclub.ticket_orders
              WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
              FOR UPDATE`, [g.tenantId, g.storeId, eventId, orderId]);
          const ord = o.rows[0];
          if (!ord) throw E.notFound('ticket order');
          if (ord.version !== b.expected_version) throw E.versionConflict(ord.version);
          if (ord.status !== 'PAID') throw E.alreadyDecided();
          const redeemed = await c.query(
            `SELECT count(*)::int AS n FROM nightclub.ticket_instances
              WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status='REDEEMED'`,
            [g.tenantId, g.storeId, orderId]);
          if (redeemed.rows[0].n > 0) {
            throw E.invalid('order has redeemed tickets; refund per ticket');
          }
          await c.query(
            `UPDATE nightclub.ticket_instances SET status='VOID'
              WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status='ISSUED'`,
            [g.tenantId, g.storeId, orderId]);
          await c.query(
            `UPDATE nightclub.ticket_orders SET status='CANCELED',
                version=version+1, updated_at=CURRENT_TIMESTAMP
              WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
            [g.tenantId, g.storeId, orderId]);
          if (ord.payment_id) {
            await c.query(
              `INSERT INTO nightclub.refunds
                 (tenant_id, store_id, event_id, payment_id, amount_minor,
                  currency, reason, requested_by, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'REQUESTED')`,
              [g.tenantId, g.storeId, eventId, ord.payment_id,
               ord.amount_minor, ord.currency, b.reason ?? 'ticket cancel',
               c0.member.membershipId]);
          }
          await audit(c, g, {
            action: 'ticket_order.cancel', targetType: 'ticket_orders',
            targetId: orderId, reason: b.reason ?? null, traceId: req.traceId,
          });
          return { httpStatus: 200, body: { status: 'CANCELED', trace_id: req.traceId } };
        },
      }));
      reply.code(res.httpStatus);
      return res.body;
    });

  // ---- redemption (entrance) -------------------------------------------------
  // QR token -> visit + AUTHORIZED segment + FIRST_ENTRY + group pass.
  app.post('/stores/:storeId/events/:eventId/tickets/redeem', {
    schema: {
      params: eventParams,
      body: body({ token: { type: 'string', minLength: 10, maxLength: 200 } },
        ['token']),
    },
  }, async (req, reply) => {
    const { storeId, eventId } = req.params as P;
    const c0 = await caller(req, storeId, eventId, 'entrance.checkin');
    const b = req.body as { token?: string };
    if (!b?.token || b.token.length < 10) throw E.invalid('token required');
    const token = b.token;
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'ticket.redeem', key: idemKey(req),
      body: { token_hash: sha256(token) }, receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const ti = await c.query(
          `SELECT ti.*, tord.buyer_name, tord.buyer_customer_id
             FROM nightclub.ticket_instances ti
             JOIN nightclub.ticket_orders tord
               ON tord.tenant_id=ti.tenant_id AND tord.store_id=ti.store_id
              AND tord.event_id=ti.event_id AND tord.id=ti.order_id
            WHERE ti.tenant_id=$1 AND ti.store_id=$2 AND ti.event_id=$3
              AND ti.token_hash=$4 FOR UPDATE OF ti`,
          [g.tenantId, g.storeId, eventId, sha256(token)]);
        const ticket = ti.rows[0];
        if (!ticket) throw E.notFound('ticket');
        if (ticket.status !== 'ISSUED') throw E.alreadyDecided();
        const ev = await c.query(
          `SELECT closes_at FROM nightclub.events
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
          [g.tenantId, g.storeId, eventId]);
        // visit
        const opId = uuid();
        const v = await c.query(
          `INSERT INTO nightclub.visits
             (tenant_id, store_id, event_id, reception_name, name_key,
              customer_id, source, planned_count, arrival_status, status)
           VALUES ($1,$2,$3,$4,$5,$6,'WALK_IN',1,'ARRIVED','ACTIVE')
           RETURNING id, version`,
          [g.tenantId, g.storeId, eventId, ticket.buyer_name,
           nameKey(ticket.buyer_name), ticket.buyer_customer_id]);
        const visitId = v.rows[0].id as string;
        await c.query(
          `INSERT INTO nightclub.visit_members
             (tenant_id, store_id, event_id, visit_id, member_kind, display_name)
           VALUES ($1,$2,$3,$4,'PRINCIPAL',$5)`,
          [g.tenantId, g.storeId, eventId, visitId, ticket.buyer_name]);
        // price rule: attach the cheapest matching rule (or any) for shape;
        // ticket price was already paid at purchase.
        const rule = await c.query(
          `SELECT pr.id FROM nightclub.price_rules pr
             JOIN nightclub.policy_versions pv
               ON pv.tenant_id=pr.tenant_id AND pv.store_id=pr.store_id
              AND pv.id=pr.policy_version_id AND pv.status='PUBLISHED'
            WHERE pr.tenant_id=$1 AND pr.store_id=$2 AND pr.event_id=$3
            ORDER BY pr.amount_minor LIMIT 1`,
          [g.tenantId, g.storeId, eventId]);
        if (!rule.rows[0]) throw E.configIncomplete('no published price rule');
        const seg = await c.query(
          `INSERT INTO nightclub.admission_segments
             (tenant_id, store_id, event_id, visit_id, price_rule_id,
              required_customer_id, requested_count, authorized_count,
              first_entered_count, unit_amount_minor, currency, status,
              authorization_method, snapshot, entry_until)
           VALUES ($1,$2,$3,$4,$5,$6,1,1,1,0,
                   (SELECT currency FROM nightclub.stores
                     WHERE tenant_id=$1 AND id=$2),
                   'AUTHORIZED','TICKET',$7,$8) RETURNING id`,
          [g.tenantId, g.storeId, eventId, visitId, rule.rows[0].id,
           ticket.buyer_customer_id,
           JSON.stringify({ rule_key: 'ticket', ticket_id: ticket.id }),
           ev.rows[0].closes_at]);
        await c.query(
          `INSERT INTO nightclub.admission_events
             (tenant_id, store_id, event_id, visit_id, segment_id,
              operator_session_id, actor_membership_id, kind, quantity,
              present_delta, first_entry_delta, operation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'FIRST_ENTRY',1,1,1,$8)`,
          [g.tenantId, g.storeId, eventId, visitId, seg.rows[0].id,
           c0.operator?.sessionId ?? null, c0.member.membershipId, opId]);
        await c.query(
          `INSERT INTO nightclub.entry_passes
             (tenant_id, store_id, event_id, visit_id, member_id, token_hash,
              pass_kind, presence, expires_at)
           SELECT $1,$2,$3,$4, vm.id, $5, 'GROUP_LOOKUP', 'INSIDE', $6
             FROM nightclub.visit_members vm
            WHERE vm.tenant_id=$1 AND vm.store_id=$2 AND vm.event_id=$3
              AND vm.visit_id=$4 AND vm.member_kind='PRINCIPAL'`,
          [g.tenantId, g.storeId, eventId, visitId,
           `pass:${visitId}:${opId}`, ev.rows[0].closes_at]);
        await c.query(
          `UPDATE nightclub.ticket_instances
              SET status='REDEEMED', redeemed_visit_id=$5, redeemed_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [g.tenantId, g.storeId, eventId, ticket.id, visitId]);
        const summary = await visitSummary(c, g, visitId, eventId);
        await emit(c, g, {
          eventId, eventType: 'ticket.redeemed', aggregateType: 'visit',
          aggregateId: visitId, aggregateVersion: 1,
          payload: { visit: summary, ticket_id: ticket.id }, traceId: req.traceId,
        });
        await audit(c, g, {
          action: 'ticket.redeem', targetType: 'ticket_instances',
          targetId: ticket.id, changes: { visit_id: visitId },
          traceId: req.traceId,
        });
        return {
          httpStatus: 200,
          body: { visit: summary, ticket_id: ticket.id, trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });
}
