// EP24/25 (R2): SaaS platform console — plans, tenant onboarding,
// subscriptions, invoices, deletion scheduling, usage.
// Access model: personal session + platform_operators row (checked via
// SECURITY DEFINER under system scope). Platform tables are system-only RLS.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withCtx, withSystem, type Client } from '../lib/db.js';
import { E } from '../lib/errors.js';
import { audit, idemKey, platformAudit, platformReceipt } from '../lib/tx.js';
import {
  body, isoTs, minor, params, storeParam, str, uuid as sUuid, version,
} from '../lib/schemas.js';
import { requirePersonal, requirePerm, gucPersonal } from '../lib/ctx.js';
import { config } from '../config.js';

const ONBOARD_ITEMS = [
  'store_created', 'floor_map', 'roles_assigned', 'operator_pin', 'policy_published',
] as const;

// Verify the caller is a registered platform operator; returns a system GUC
// stamped with the caller's user id (for audit attribution).
async function requirePlatform(req: FastifyRequest): Promise<{
  userId: string;
  sys: <T>(fn: (c: Client) => Promise<T>) => Promise<T>;
}> {
  const p = await req.auth.personal();
  if (!p) throw E.unauthenticated();
  const sys = <T>(fn: (c: Client) => Promise<T>) =>
    withSystem(fn, undefined, { userId: p.userId });
  const ok = await sys(async (c) => {
    const r = await c.query(
      `SELECT nightclub.platform_is_operator() AS ok`,
      [], // ctx_user() is read from app.user_id GUC
    ).catch(() => ({ rows: [{ ok: false }] }));
    return r.rows[0]?.ok === true;
  });
  if (!ok) throw E.forbidden('platform operator required');
  return { userId: p.userId, sys };
}

export default async function platformRoutes(app: FastifyInstance) {
  // ---- tenants ------------------------------------------------------------
  app.get('/platform/tenants', async (req) => {
    const { sys } = await requirePlatform(req);
    return sys(async (c) => {
      const r = await c.query(
        `SELECT t.id, t.name, t.status, t.created_at,
                (SELECT count(*)::int FROM nightclub.stores s WHERE s.tenant_id=t.id) AS stores,
                (SELECT row_to_json(x) FROM (
                   SELECT id, plan_id, status, current_period_end, trial_ends_at
                     FROM nightclub.tenant_subscriptions
                    WHERE tenant_id=t.id AND status<>'CANCELED' LIMIT 1) x
                ) AS subscription,
                (SELECT count(*)::int FROM nightclub.tenant_onboarding o
                  WHERE o.tenant_id=t.id AND o.done_at IS NOT NULL) AS onboarding_done
           FROM nightclub.tenants t ORDER BY t.created_at`);
      return { items: r.rows };
    });
  });

  app.post('/platform/tenants', {
    schema: { body: body({ name: str(120) }, ['name']) },
  }, async (req, reply) => {
    const { userId, sys } = await requirePlatform(req);
    const b = req.body as { name?: string };
    if (!b?.name || b.name.length > 120) throw E.invalid('name required');
    const res = await sys(async (c) => platformReceipt(c, {
      actorKey: `platform:${userId}`, operation: 'tenant.create',
      key: idemKey(req), body: b, receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const t = await c.query(
          `INSERT INTO nightclub.tenants (name) VALUES ($1) RETURNING id`,
          [b.name]);
        const tid = t.rows[0].id as string;
        for (const k of ONBOARD_ITEMS) {
          await c.query(
            `INSERT INTO nightclub.tenant_onboarding (tenant_id, item_key)
             VALUES ($1,$2)`, [tid, k]);
        }
        await platformAudit(c, {
          actorUserId: userId, tenantId: tid,
          action: 'platform.tenant.create', targetType: 'tenants',
          targetId: tid, changes: { name: b.name }, traceId: req.traceId,
        });
        return { httpStatus: 201, body: { tenant_id: tid, trace_id: req.traceId } };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- plans ----------------------------------------------------------------
  app.get('/platform/plans', async (req) => {
    const { sys } = await requirePlatform(req);
    return sys(async (c) => ({
      items: (await c.query(
        `SELECT id, code, name, features, limits, monthly_price_minor, currency, status
           FROM nightclub.plans ORDER BY code`)).rows,
    }));
  });

  app.post('/platform/plans', {
    schema: {
      body: body({
        code: str(64), name: str(120),
        features: { type: 'object' }, limits: { type: 'object' },
        monthly_price_minor: minor, currency: { type: 'string', pattern: '^[A-Z]{3}$' },
      }, ['code', 'name']),
    },
  }, async (req, reply) => {
    const { userId, sys } = await requirePlatform(req);
    const b = req.body as {
      code?: string; name?: string; features?: Record<string, unknown>;
      limits?: Record<string, unknown>; monthly_price_minor?: number | null;
      currency?: string;
    };
    if (!b?.code || !b.name) throw E.invalid('code and name required');
    const res = await sys(async (c) => platformReceipt(c, {
      actorKey: `platform:${userId}`, operation: 'plan.create',
      key: idemKey(req), body: b, receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const r = await c.query(
          `INSERT INTO nightclub.plans (code, name, features, limits, monthly_price_minor, currency)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [b.code, b.name, JSON.stringify(b.features ?? {}),
           JSON.stringify(b.limits ?? {}), b.monthly_price_minor ?? null,
           (b.currency ?? 'JPY').slice(0, 3)]);
        return { httpStatus: 201, body: { plan_id: r.rows[0].id, trace_id: req.traceId } };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- subscriptions --------------------------------------------------------
  // Create or replace (cancel current + start new) the tenant subscription.
  app.post('/platform/tenants/:tenantId/subscription', {
    schema: {
      params: params({ tenantId: sUuid }),
      body: body({
        plan_id: sUuid,
        trial_days: { type: 'integer', minimum: 0, maximum: 365 },
        period_days: { type: 'integer', minimum: 1, maximum: 366 },
      }, ['plan_id']),
    },
  }, async (req, reply) => {
    const { userId, sys } = await requirePlatform(req);
    const { tenantId } = req.params as { tenantId: string };
    const b = req.body as {
      plan_id?: string; trial_days?: number; period_days?: number;
    };
    if (!b?.plan_id) throw E.invalid('plan_id required');
    const res = await sys(async (c) => platformReceipt(c, {
      actorKey: `platform:${userId}`, operation: 'subscription.set',
      key: idemKey(req), body: { ...b, tenantId }, receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const t = await c.query(
          `SELECT id FROM nightclub.tenants WHERE id=$1`, [tenantId]);
        if (!t.rows[0]) throw E.notFound('tenant');
        const p = await c.query(
          `SELECT id, status FROM nightclub.plans WHERE id=$1`, [b.plan_id]);
        if (!p.rows[0] || p.rows[0].status !== 'ACTIVE') throw E.invalid('plan not active');
        const now = new Date();
        const periodEnd = new Date(now.getTime() + (b.period_days ?? 30) * 86400_000);
        const trialEnd = b.trial_days
          ? new Date(now.getTime() + b.trial_days * 86400_000) : null;
        await c.query(
          `UPDATE nightclub.tenant_subscriptions
              SET status='CANCELED', canceled_at=CURRENT_TIMESTAMP,
                  version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND status<>'CANCELED'`, [tenantId]);
        const ins = await c.query(
          `INSERT INTO nightclub.tenant_subscriptions
             (tenant_id, plan_id, status, trial_ends_at,
              current_period_start, current_period_end)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status`,
          [tenantId, b.plan_id, trialEnd ? 'TRIAL' : 'ACTIVE',
           trialEnd, now, periodEnd]);
        await platformAudit(c, {
          actorUserId: userId, tenantId: tenantId,
          action: 'platform.subscription.set', targetType: 'tenant_subscriptions',
          targetId: ins.rows[0].id, changes: { plan_id: b.plan_id },
          traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: { subscription_id: ins.rows[0].id, status: ins.rows[0].status, trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // Billing state transitions: activate / past_due / suspend / cancel.
  app.post('/platform/subscriptions/:subscriptionId/transition', {
    schema: {
      params: params({ subscriptionId: sUuid }),
      body: body({
        status: { type: 'string', enum: ['ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED'] },
        expected_version: version,
      }, ['status', 'expected_version']),
    },
  }, async (req, reply) => {
    const { userId, sys } = await requirePlatform(req);
    const { subscriptionId } = req.params as { subscriptionId: string };
    const b = req.body as { status?: string; expected_version?: number };
    const allowed = ['ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED'];
    if (!allowed.includes(b?.status ?? '') || typeof b.expected_version !== 'number') {
      throw E.invalid('status and expected_version required');
    }
    const expectedVersion = b.expected_version;
    const res = await sys(async (c) => platformReceipt(c, {
      actorKey: `platform:${userId}`, operation: 'subscription.transition',
      key: idemKey(req), body: { ...b, subscriptionId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const s = await c.query(
          `SELECT id, tenant_id, status, version FROM nightclub.tenant_subscriptions
            WHERE id=$1 FOR UPDATE`, [subscriptionId]);
        if (!s.rows[0]) throw E.notFound('subscription');
        if (s.rows[0].version !== expectedVersion) {
          throw E.versionConflict(s.rows[0].version);
        }
        if (s.rows[0].status === 'CANCELED') throw E.alreadyDecided();
        const upd = await c.query(
          `UPDATE nightclub.tenant_subscriptions
              SET status=$3, canceled_at=CASE WHEN $3='CANCELED' THEN CURRENT_TIMESTAMP ELSE canceled_at END,
                  version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND id=$2 RETURNING status`,
          [s.rows[0].tenant_id, subscriptionId, b.status]);
        await platformAudit(c, {
          actorUserId: userId, tenantId: s.rows[0].tenant_id,
          action: 'platform.subscription.transition',
          targetType: 'tenant_subscriptions', targetId: subscriptionId,
          beforeVersion: expectedVersion, afterVersion: expectedVersion + 1,
          changes: { status: b.status }, traceId: req.traceId,
        });
        return { httpStatus: 200, body: { status: upd.rows[0].status, trace_id: req.traceId } };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- invoices ---------------------------------------------------------------
  app.post('/platform/tenants/:tenantId/invoices', {
    schema: {
      params: params({ tenantId: sUuid }),
      body: body({
        subscription_id: sUuid, period_start: isoTs, period_end: isoTs,
        amount_minor: minor, currency: { type: 'string', pattern: '^[A-Z]{3}$' },
        due_at: isoTs,
      }, ['subscription_id', 'period_start', 'period_end', 'amount_minor']),
    },
  }, async (req, reply) => {
    const { userId, sys } = await requirePlatform(req);
    const { tenantId } = req.params as { tenantId: string };
    const b = req.body as {
      subscription_id?: string; period_start?: string; period_end?: string;
      amount_minor?: number; currency?: string; due_at?: string;
    };
    if (!b?.subscription_id || !b.period_start || !b.period_end
        || typeof b.amount_minor !== 'number' || b.amount_minor < 0) {
      throw E.invalid('subscription_id, period, amount_minor required');
    }
    const res = await sys(async (c) => platformReceipt(c, {
      actorKey: `platform:${userId}`, operation: 'invoice.create',
      key: idemKey(req), body: { ...b, tenantId }, receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const r = await c.query(
          `INSERT INTO nightclub.billing_invoices
             (tenant_id, subscription_id, period_start, period_end,
              amount_minor, currency, due_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [tenantId, b.subscription_id, b.period_start, b.period_end,
           b.amount_minor, (b.currency ?? 'JPY').slice(0, 3), b.due_at ?? null]);
        await platformAudit(c, {
          actorUserId: userId, tenantId: tenantId,
          action: 'platform.invoice.create', targetType: 'billing_invoices',
          targetId: r.rows[0].id, changes: b, traceId: req.traceId,
        });
        return { httpStatus: 201, body: { invoice_id: r.rows[0].id, trace_id: req.traceId } };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  app.post('/platform/invoices/:invoiceId/transition', {
    schema: {
      params: params({ invoiceId: sUuid }),
      body: body({
        status: { type: 'string', enum: ['ISSUED', 'PAID', 'FAILED', 'VOID'] },
        expected_version: version, external_ref: str(200),
      }, ['status', 'expected_version']),
    },
  }, async (req, reply) => {
    const { userId, sys } = await requirePlatform(req);
    const { invoiceId } = req.params as { invoiceId: string };
    const b = req.body as { status?: string; expected_version?: number; external_ref?: string };
    const allowed = ['ISSUED', 'PAID', 'FAILED', 'VOID'];
    if (!allowed.includes(b?.status ?? '') || typeof b.expected_version !== 'number') {
      throw E.invalid('status and expected_version required');
    }
    const res = await sys(async (c) => platformReceipt(c, {
      actorKey: `platform:${userId}`, operation: 'invoice.transition',
      key: idemKey(req), body: { ...b, invoiceId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const inv = await c.query(
          `SELECT id, tenant_id, status, version FROM nightclub.billing_invoices
            WHERE id=$1 FOR UPDATE`, [invoiceId]);
        if (!inv.rows[0]) throw E.notFound('invoice');
        if (inv.rows[0].version !== b.expected_version) {
          throw E.versionConflict(inv.rows[0].version);
        }
        if (['PAID', 'VOID'].includes(inv.rows[0].status)) throw E.alreadyDecided();
        const upd = await c.query(
          `UPDATE nightclub.billing_invoices
              SET status=$3, paid_at=CASE WHEN $3='PAID' THEN CURRENT_TIMESTAMP ELSE paid_at END,
                  external_ref=COALESCE($4, external_ref),
                  version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND id=$2 RETURNING status`,
          [inv.rows[0].tenant_id, invoiceId, b.status, b.external_ref ?? null]);
        await platformAudit(c, {
          actorUserId: userId, tenantId: inv.rows[0].tenant_id,
          action: 'platform.invoice.transition', targetType: 'billing_invoices',
          targetId: invoiceId, changes: { status: b.status }, traceId: req.traceId,
        });
        return { httpStatus: 200, body: { status: upd.rows[0].status, trace_id: req.traceId } };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- deletion scheduling ----------------------------------------------------
  app.post('/platform/tenants/:tenantId/deletion-requests', {
    schema: {
      params: params({ tenantId: sUuid }),
      body: body({ execute_after: isoTs }, ['execute_after']),
    },
  }, async (req, reply) => {
    const { userId, sys } = await requirePlatform(req);
    const { tenantId } = req.params as { tenantId: string };
    const b = req.body as { execute_after?: string };
    if (!b?.execute_after) throw E.invalid('execute_after required');
    const res = await sys(async (c) => platformReceipt(c, {
      actorKey: `platform:${userId}`, operation: 'deletion.schedule',
      key: idemKey(req), body: { ...b, tenantId }, receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const t = await c.query(
          `SELECT id FROM nightclub.tenants WHERE id=$1`, [tenantId]);
        if (!t.rows[0]) throw E.notFound('tenant');
        const ex = await c.query(
          `SELECT id FROM nightclub.tenant_deletion_requests
            WHERE tenant_id=$1 AND status='SCHEDULED'`, [tenantId]);
        if (ex.rows[0]) throw E.alreadyDecided();
        const r = await c.query(
          `INSERT INTO nightclub.tenant_deletion_requests
             (tenant_id, requested_by, execute_after)
           VALUES ($1,$2,$3) RETURNING id`,
          [tenantId, userId, b.execute_after]);
        await platformAudit(c, {
          actorUserId: userId, tenantId: tenantId,
          action: 'platform.deletion.schedule',
          targetType: 'tenant_deletion_requests', targetId: r.rows[0].id,
          changes: { execute_after: b.execute_after }, traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: { deletion_request_id: r.rows[0].id, trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  app.post('/platform/deletion-requests/:requestId/cancel', {
    schema: {
      params: params({ requestId: sUuid }),
      body: body({ expected_version: version }, ['expected_version']),
    },
  }, async (req, reply) => {
    const { userId, sys } = await requirePlatform(req);
    const { requestId } = req.params as { requestId: string };
    const b = (req.body ?? {}) as { expected_version?: number };
    if (typeof b.expected_version !== 'number') throw E.invalid('expected_version required');
    const res = await sys(async (c) => platformReceipt(c, {
      actorKey: `platform:${userId}`, operation: 'deletion.cancel',
      key: idemKey(req), body: { ...b, requestId }, receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const r = await c.query(
          `SELECT id, tenant_id, status, version FROM nightclub.tenant_deletion_requests
            WHERE id=$1 FOR UPDATE`, [requestId]);
        if (!r.rows[0]) throw E.notFound('deletion request');
        if (r.rows[0].version !== b.expected_version) {
          throw E.versionConflict(r.rows[0].version);
        }
        if (r.rows[0].status !== 'SCHEDULED') throw E.alreadyDecided();
        await c.query(
          `UPDATE nightclub.tenant_deletion_requests
              SET status='CANCELED', version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND id=$2`, [r.rows[0].tenant_id, requestId]);
        await platformAudit(c, {
          actorUserId: userId, tenantId: r.rows[0].tenant_id,
          action: 'platform.deletion.cancel',
          targetType: 'tenant_deletion_requests', targetId: requestId,
          traceId: req.traceId,
        });
        return { httpStatus: 200, body: { status: 'CANCELED', trace_id: req.traceId } };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- onboarding -------------------------------------------------------------
  app.get('/platform/tenants/:tenantId/onboarding', {
    schema: { params: params({ tenantId: sUuid }) },
  }, async (req) => {
    const { sys } = await requirePlatform(req);
    const { tenantId } = req.params as { tenantId: string };
    return sys(async (c) => ({
      items: (await c.query(
        `SELECT item_key, done_at, done_by FROM nightclub.tenant_onboarding
          WHERE tenant_id=$1 ORDER BY item_key`, [tenantId])).rows,
    }));
  });

  app.put('/platform/tenants/:tenantId/onboarding/:itemKey', {
    schema: {
      params: params({ tenantId: sUuid, itemKey: { type: 'string', enum: ONBOARD_ITEMS } }),
      body: body({ done: { type: 'boolean' } }),
    },
  }, async (req) => {
    const { userId, sys } = await requirePlatform(req);
    const { tenantId, itemKey } = req.params as { tenantId: string; itemKey: string };
    const b = (req.body ?? {}) as { done?: boolean };
    return sys(async (c) => {
      const r = await c.query(
        `UPDATE nightclub.tenant_onboarding
            SET done_at=CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE NULL END,
                done_by=CASE WHEN $3 THEN $4::uuid ELSE NULL END
          WHERE tenant_id=$1 AND item_key=$2 RETURNING item_key`,
        [tenantId, itemKey, b.done === true, userId]);
      if (!r.rows[0]) throw E.notFound('onboarding item');
      await platformAudit(c, {
        actorUserId: userId, tenantId,
        action: 'platform.onboarding.update', targetType: 'tenant_onboarding',
        targetId: tenantId, changes: { item_key: itemKey, done: b.done === true },
        traceId: req.traceId,
      });
      return { item_key: itemKey, done: b.done === true };
    });
  });

  // ---- usage (D-8: per-tenant usage for the SaaS console) -----------------------
  app.get('/platform/usage', async (req) => {
    const { sys } = await requirePlatform(req);
    return sys(async (c) => ({
      items: (await c.query(
        `SELECT t.id AS tenant_id, t.name,
                (SELECT count(*)::int FROM nightclub.stores s WHERE s.tenant_id=t.id) AS stores,
                (SELECT count(*)::int FROM nightclub.memberships m WHERE m.tenant_id=t.id) AS memberships,
                (SELECT count(*)::int FROM nightclub.visits v WHERE v.tenant_id=t.id) AS visits,
                (SELECT count(*)::int FROM nightclub.bookings b WHERE b.tenant_id=t.id) AS bookings,
                (SELECT COALESCE(sum(p.amount_minor),0)::bigint FROM nightclub.payments p
                  WHERE p.tenant_id=t.id AND p.status IN ('SUCCEEDED','PARTIAL_REFUND')) AS gmv_minor
           FROM nightclub.tenants t ORDER BY t.created_at`)).rows,
    }));
  });
}

// tenant-scoped store settings (EP25): update name/timezone/currency.
export async function storeSettingsRoutes(app: FastifyInstance) {
  app.patch('/stores/:storeId', {
    schema: {
      params: storeParam,
      body: body({
        name: str(200), timezone: str(64),
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
      }),
    },
  }, async (req) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'policy.manage');
    const b = req.body as { name?: string; timezone?: string; currency?: string };
    if (!b?.name && !b.timezone && !b.currency) throw E.invalid('nothing to update');
    if (b.currency && !/^[A-Z]{3}$/.test(b.currency)) throw E.invalid('currency must be ISO4217');
    return withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => {
        const r = await c.query(
          `UPDATE nightclub.stores
              SET name=COALESCE($3,name), timezone=COALESCE($4,timezone),
                  currency=COALESCE($5,currency),
                  version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND id=$2 AND status<>'CLOSED'
            RETURNING id, name, timezone, currency, status, version`,
          [member.tenantId, storeId, b.name ?? null, b.timezone ?? null,
           b.currency ?? null]);
        if (!r.rows[0]) throw E.notFound('store');
        await audit(c,
          gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
          {
            action: 'store.update', targetType: 'stores', targetId: storeId,
            changes: b, traceId: req.traceId,
          });
        return { store: r.rows[0] };
      });
  });
}
