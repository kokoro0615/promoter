// EP27 (R3): products, stock movements (append-only), POS orders, bottle
// keeps. Sellout is prevented by locking the product row inside the order tx.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Guc } from '../lib/db.js';
import { withCtx } from '../lib/db.js';
import { E } from '../lib/errors.js';
import { uuid } from '../lib/crypto.js';
import { audit, emit, idemKey, withReceipt } from '../lib/tx.js';
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
  storeId: string; eventId: string; productId: string; keepId: string;
};

async function applyMovement(
  c: import('../lib/db.js').Client, g: Guc, a: {
    productId: string; kind: string; quantity: number;
    ref?: string | null; createdBy: string | null; operationId: string;
  },
) {
  // quantity signed for ADJUST; IN/RETURN positive; OUT/SALE positive counts
  // that decrement stock.
  const delta = a.kind === 'ADJUST' ? a.quantity
    : (a.kind === 'IN' || a.kind === 'RETURN' ? Math.abs(a.quantity)
      : -Math.abs(a.quantity));
  const p = await c.query(
    `UPDATE nightclub.products
        SET stock_on_hand = stock_on_hand + $4,
            version=version+1, updated_at=CURRENT_TIMESTAMP
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3
      RETURNING stock_on_hand, stock_tracked`,
    [g.tenantId, g.storeId, a.productId, delta]);
  if (!p.rows[0]) throw E.notFound('product');
  if (p.rows[0].stock_on_hand < 0) throw E.quotaExceeded();
  await c.query(
    `INSERT INTO nightclub.stock_movements
       (tenant_id, store_id, product_id, kind, quantity, ref, created_by, operation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [g.tenantId, g.storeId, a.productId, a.kind, a.quantity,
     a.ref ?? null, a.createdBy, a.operationId]);
  return p.rows[0].stock_on_hand as number;
}

export default async function posRoutes(app: FastifyInstance) {
  // ---- products --------------------------------------------------------------
  app.post('/stores/:storeId/products', async (req, reply) => {
    const { storeId } = req.params as P;
    const c0 = await caller(req, storeId, null, 'policy.manage');
    const b = req.body as {
      sku?: string; name?: string; kind?: string; price_minor?: number;
      currency?: string; stock_tracked?: boolean; initial_stock?: number;
    };
    if (!b?.sku || !b.name || !['BOTTLE', 'ITEM', 'PACKAGE'].includes(b.kind ?? '')
        || typeof b.price_minor !== 'number' || b.price_minor < 0) {
      throw E.invalid('sku, name, kind, price_minor required');
    }
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'product.create', key: idemKey(req), body: b,
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const r = await c.query(
          `INSERT INTO nightclub.products
             (tenant_id, store_id, sku, name, kind, price_minor, currency,
              stock_tracked, stock_on_hand)
           VALUES ($1,$2,$3,$4,$5,$6,
                   COALESCE($7,(SELECT currency FROM nightclub.stores
                                 WHERE tenant_id=$1 AND id=$2)),
                   $8,$9) RETURNING id`,
          [g.tenantId, storeId, b.sku, b.name, b.kind, b.price_minor,
           b.currency ?? null, b.stock_tracked === true,
           b.initial_stock ?? 0]);
        if (b.initial_stock) {
          await c.query(
            `INSERT INTO nightclub.stock_movements
               (tenant_id, store_id, product_id, kind, quantity, ref,
                created_by, operation_id)
             VALUES ($1,$2,$3,'IN',$4,'initial',$5,$6)`,
            [g.tenantId, storeId, r.rows[0].id, b.initial_stock,
             c0.member.membershipId, uuid()]);
        }
        await audit(c, g, {
          action: 'product.create', targetType: 'products',
          targetId: r.rows[0].id, changes: b, traceId: req.traceId,
        });
        return { httpStatus: 201, body: { product_id: r.rows[0].id, trace_id: req.traceId } };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  app.get('/stores/:storeId/products', async (req) => {
    const { storeId } = req.params as P;
    const c0 = await caller(req, storeId, null, 'sales.read');
    return withCtx(c0.g, async (c) => ({
      items: (await c.query(
        `SELECT id, sku, name, kind, price_minor, currency, stock_tracked,
                stock_on_hand, status, version
           FROM nightclub.products
          WHERE tenant_id=$1 AND store_id=$2 ORDER BY sku`,
        [c0.g.tenantId, storeId])).rows,
    }));
  });

  // Stock adjustment (restock / write-off / correction). SALE movements are
  // created only by POS orders.
  app.post('/stores/:storeId/products/:productId/stock', async (req, reply) => {
    const { storeId, productId } = req.params as P;
    const c0 = await caller(req, storeId, null, 'sales.record');
    const b = req.body as { kind?: string; quantity?: number; ref?: string };
    if (!['IN', 'OUT', 'ADJUST'].includes(b?.kind ?? '')
        || typeof b.quantity !== 'number' || b.quantity === 0) {
      throw E.invalid('kind IN/OUT/ADJUST and non-zero quantity required');
    }
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'stock.move', key: idemKey(req),
      body: { ...b, productId }, receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const onHand = await applyMovement(c, g, {
          productId, kind: b.kind!, quantity: b.quantity!, ref: b.ref ?? null,
          createdBy: c0.member.membershipId, operationId: uuid(),
        });
        await audit(c, g, {
          action: 'stock.move', targetType: 'products', targetId: productId,
          changes: { kind: b.kind, quantity: b.quantity, ref: b.ref },
          traceId: req.traceId,
        });
        return { httpStatus: 200, body: { stock_on_hand: onHand, trace_id: req.traceId } };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  app.get('/stores/:storeId/products/:productId/movements', async (req) => {
    const { storeId, productId } = req.params as P;
    const c0 = await caller(req, storeId, null, 'sales.read');
    return withCtx(c0.g, async (c) => ({
      items: (await c.query(
        `SELECT id, kind, quantity, ref, created_at FROM nightclub.stock_movements
          WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3
          ORDER BY created_at DESC LIMIT 200`,
        [c0.g.tenantId, storeId, productId])).rows,
    }));
  });

  // ---- POS order ---------------------------------------------------------------
  // Atomic: product rows locked, stock checked, order+lines+payment+SALE
  // movements in one transaction.
  app.post('/stores/:storeId/events/:eventId/pos/orders', async (req, reply) => {
    const { storeId, eventId } = req.params as P;
    const c0 = await caller(req, storeId, eventId, 'sales.record');
    const b = req.body as {
      lines?: { product_id: string; quantity: number }[];
      method?: string; visit_id?: string | null;
    };
    if (!Array.isArray(b?.lines) || !b.lines.length || !b.method) {
      throw E.invalid('lines and method required');
    }
    if (!['CASH', 'EXTERNAL_TERMINAL'].includes(b.method)) {
      throw E.invalid('method must be CASH or EXTERNAL_TERMINAL');
    }
    for (const l of b.lines) {
      if (!l.product_id || typeof l.quantity !== 'number' || l.quantity <= 0) {
        throw E.invalid('each line needs product_id and positive quantity');
      }
    }
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'pos.order', key: idemKey(req), body: b,
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        // Lock products in deterministic order to avoid deadlocks.
        const ids = [...new Set(b.lines!.map((l) => l.product_id))].sort();
        const prows = await c.query(
          `SELECT id, sku, name, price_minor, currency, stock_tracked, stock_on_hand, status
             FROM nightclub.products
            WHERE tenant_id=$1 AND store_id=$2 AND id = ANY($3::uuid[])
            FOR UPDATE`, [g.tenantId, g.storeId, ids]);
        const byId = new Map(prows.rows.map((r) => [r.id as string, r]));
        let total = 0; let currency: string | null = null;
        for (const l of b.lines!) {
          const p = byId.get(l.product_id);
          if (!p || p.status !== 'ACTIVE') throw E.invalid(`product unavailable`);
          if (currency && p.currency !== currency) throw E.invalid('mixed currency');
          currency = p.currency;
          if (p.stock_tracked && p.stock_on_hand < l.quantity) {
            throw E.validation('sold out', [{
              path: 'lines', code: 'SOLD_OUT',
              message: `${p.name}: ${p.stock_on_hand} left`,
            }]);
          }
          total += l.quantity * Number(p.price_minor);
        }
        const ord = await c.query(
          `INSERT INTO nightclub.sales_orders
             (tenant_id, store_id, event_id, kind, visit_id, currency, status)
           VALUES ($1,$2,$3,'POS',$4,$5,'FINALIZED') RETURNING id`,
          [g.tenantId, g.storeId, eventId, b.visit_id ?? null, currency]);
        const orderId = ord.rows[0].id as string;
        const opId = uuid();
        for (const l of b.lines!) {
          const p = byId.get(l.product_id)!;
          await c.query(
            `INSERT INTO nightclub.sales_lines
               (tenant_id, store_id, event_id, order_id, category, line_kind,
                description, quantity, gross_minor, tax_minor, currency, source_key)
             VALUES ($1,$2,$3,$4,'PRODUCT','SALE',$5,$6,$7,0,$8,$9)`,
            [g.tenantId, g.storeId, eventId, orderId, `${p.sku} ${p.name}`,
             l.quantity, l.quantity * Number(p.price_minor), p.currency,
             `pos:${orderId}:${l.product_id}`]);
          if (p.stock_tracked) {
            await applyMovement(c, g, {
              productId: l.product_id, kind: 'SALE', quantity: l.quantity,
              ref: `pos:${orderId}`, createdBy: c0.member.membershipId,
              operationId: opId,
            });
          }
        }
        const pay = await c.query(
          `INSERT INTO nightclub.payments
             (tenant_id, store_id, event_id, recorded_by, operator_session_id,
              order_id, method, purpose, amount_minor, currency, status,
              operation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'PRODUCT',$8,$9,'SUCCEEDED',$10)
           RETURNING id`,
          [g.tenantId, g.storeId, eventId, c0.member.membershipId,
           c0.operator?.sessionId ?? null, orderId, b.method, total,
           currency, opId]);
        await emit(c, g, {
          eventId, eventType: 'pos.sale', aggregateType: 'sales_order',
          aggregateId: orderId, aggregateVersion: 1,
          payload: { order_id: orderId, total_minor: total },
          traceId: req.traceId,
        });
        await audit(c, g, {
          action: 'pos.order', targetType: 'sales_orders', targetId: orderId,
          changes: { lines: b.lines, total }, traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: {
            order_id: orderId, payment_id: pay.rows[0].id,
            total_minor: total, currency, trace_id: req.traceId,
          },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- bottle keeps -------------------------------------------------------------
  app.post('/stores/:storeId/bottle-keeps', async (req, reply) => {
    const { storeId } = req.params as P;
    const c0 = await caller(req, storeId, null, 'customer.manage');
    const b = req.body as {
      customer_id?: string; product_id?: string; label?: string;
      expires_at?: string; order_id?: string | null;
    };
    if (!b?.customer_id || !b.product_id || !b.label || !b.expires_at) {
      throw E.invalid('customer_id, product_id, label, expires_at required');
    }
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'bottle_keep.create', key: idemKey(req), body: b,
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const r = await c.query(
          `INSERT INTO nightclub.bottle_keeps
             (tenant_id, store_id, customer_id, product_id, order_id, label, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [g.tenantId, storeId, b.customer_id, b.product_id,
           b.order_id ?? null, b.label, b.expires_at]);
        await audit(c, g, {
          action: 'bottle_keep.create', targetType: 'bottle_keeps',
          targetId: r.rows[0].id, changes: b, traceId: req.traceId,
        });
        return { httpStatus: 201, body: { bottle_keep_id: r.rows[0].id, trace_id: req.traceId } };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  app.get('/stores/:storeId/bottle-keeps', async (req) => {
    const { storeId } = req.params as P;
    const c0 = await caller(req, storeId, null, 'sales.read');
    const q = req.query as { customer_id?: string };
    return withCtx(c0.g, async (c) => ({
      items: (await c.query(
        `SELECT bk.id, bk.customer_id, cu.display_name AS customer_name,
                bk.product_id, p.name AS product_name, p.sku,
                bk.label, bk.opened_at, bk.expires_at, bk.remaining_percent,
                bk.status, bk.version
           FROM nightclub.bottle_keeps bk
           JOIN nightclub.customers cu
             ON cu.tenant_id=bk.tenant_id AND cu.store_id=bk.store_id
            AND cu.id=bk.customer_id
           JOIN nightclub.products p
             ON p.tenant_id=bk.tenant_id AND p.store_id=bk.store_id
            AND p.id=bk.product_id
          WHERE bk.tenant_id=$1 AND bk.store_id=$2
            AND ($3::uuid IS NULL OR bk.customer_id=$3)
          ORDER BY bk.expires_at`,
        [c0.g.tenantId, storeId, q.customer_id ?? null])).rows,
    }));
  });

  app.patch('/stores/:storeId/bottle-keeps/:keepId', async (req, reply) => {
    const { storeId, keepId } = req.params as P;
    const c0 = await caller(req, storeId, null, 'customer.manage');
    const b = req.body as {
      remaining_percent?: number; status?: string; expected_version?: number;
    };
    if (typeof b?.expected_version !== 'number'
        || (b.status && !['FINISHED', 'DISCARDED'].includes(b.status))) {
      throw E.invalid('expected_version required; status FINISHED|DISCARDED');
    }
    const g = c0.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: c0.operator?.sessionId ?? c0.member.membershipId,
      operation: 'bottle_keep.update', key: idemKey(req),
      body: { ...b, keepId }, receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const r = await c.query(
          `SELECT id, status, version FROM nightclub.bottle_keeps
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,
          [g.tenantId, g.storeId, keepId]);
        if (!r.rows[0]) throw E.notFound('bottle keep');
        if (r.rows[0].version !== b.expected_version) {
          throw E.versionConflict(r.rows[0].version);
        }
        if (r.rows[0].status !== 'OPEN' && b.status) throw E.alreadyDecided();
        const upd = await c.query(
          `UPDATE nightclub.bottle_keeps
              SET remaining_percent=COALESCE($4,remaining_percent),
                  status=COALESCE($5,status),
                  version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3 RETURNING status`,
          [g.tenantId, g.storeId, keepId,
           b.remaining_percent ?? null, b.status ?? null]);
        await audit(c, g, {
          action: 'bottle_keep.update', targetType: 'bottle_keeps',
          targetId: keepId, changes: b, traceId: req.traceId,
        });
        return { httpStatus: 200, body: { status: upd.rows[0].status, trace_id: req.traceId } };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });
}
