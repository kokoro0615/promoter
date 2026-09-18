// Customer search + management. Name search is NOT identity proof; same-name
// customers are returned as separate rows and never merged.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Guc } from '../lib/db.js';
import { withCtx } from '../lib/db.js';
import { E } from '../lib/errors.js';
import { nameKey, kanaKey } from '../lib/namekey.js';
import { audit } from '../lib/tx.js';
import {
  body, params, query, storeParam, str, uuid as sUuid, version,
} from '../lib/schemas.js';
import {
  requirePersonal, requirePerm, requireOperator, type MemberCtx, type OperatorCtx, gucPersonal, gucOperator,
} from '../lib/ctx.js';

interface Caller { g: Guc; member: MemberCtx; operator?: OperatorCtx }

// Resolve the caller for a store-scoped customer route: personal member or
// active operator session on the same store.
async function customerCaller(req: FastifyRequest, storeId: string): Promise<Caller> {
  const op = await req.auth.operator().catch((e) => {
    if ((e as { code?: string }).code === 'OPERATOR_CHANGED') throw e;
    return null;
  });
  if (op && op.storeId === storeId) {
    const { member } = await requireOperator(req);
    return { g: gucOperator(op), member, operator: op };
  }
  const { member, personal } = await requirePersonal(req, storeId);
  return {
    g: gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
    member,
  };
}

export default async function customerRoutes(app: FastifyInstance) {
  // Name-centered search. Min 1 char; prefix (btree) + substring (trgm) +
  // kana/alias keys. Candidates stay separate per customer row.
  app.get('/stores/:storeId/customers', {
    schema: {
      params: storeParam,
      querystring: query({
        q: str(200),
        limit: { type: 'string', pattern: '^[0-9]+$', maxLength: 4 },
      }),
    },
  }, async (req) => {
    const { storeId } = req.params as { storeId: string };
    const q = (req.query as { q?: string; limit?: string }).q ?? '';
    const limit = Math.min(Number((req.query as { limit?: string }).limit) || 30, 100);
    const { g, member } = await customerCaller(req, storeId);
    requirePerm(member, 'customer.lookup');
    const key = nameKey(q);
    const kana = kanaKey(q);
    return withCtx(g, async (c) => {
      if (!key) return { items: [] };
      const r = await c.query(
        `SELECT DISTINCT c.id, c.display_name, c.regular_status, c.masked_hint, c.version
           FROM nightclub.customers c
           LEFT JOIN nightclub.customer_aliases a
             ON a.tenant_id=c.tenant_id AND a.store_id=c.store_id AND a.customer_id=c.id
          WHERE c.tenant_id=$1 AND c.store_id=$2
            AND (c.name_key LIKE $3 || '%' OR c.name_key LIKE '%' || $3 || '%'
                 OR c.kana_key LIKE '%' || $4 || '%'
                 OR a.alias_key LIKE $3 || '%' OR a.alias_key LIKE '%' || $3 || '%')
          ORDER BY c.display_name, c.id
          LIMIT $5`,
        [member.tenantId, storeId, key, kana, limit]);
      return { items: r.rows };
    });
  });

  app.post('/stores/:storeId/customers', {
    schema: {
      params: storeParam,
      body: body({
        display_name: str(200), reading: str(200),
        aliases: { type: 'array', items: str(200), maxItems: 20 },
      }, ['display_name']),
    },
  }, async (req, reply) => {
    const { storeId } = req.params as { storeId: string };
    const { g, member } = await customerCaller(req, storeId);
    if (!member.permissions.has('customer.manage') && !member.permissions.has('visit.create')) {
      throw E.forbidden('customer create not permitted');
    }
    const b = req.body as { display_name?: string; reading?: string; aliases?: string[] };
    if (!b?.display_name?.trim()) throw E.invalid('display_name required');
    const row = await withCtx(g, async (c) => {
      const ins = await c.query(
        `INSERT INTO nightclub.customers
           (tenant_id, store_id, display_name, name_key, kana_key)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, version`,
        [member.tenantId, storeId, b.display_name!.trim(),
         nameKey(b.display_name!), kanaKey(b.reading || b.display_name!)]);
      const id = ins.rows[0].id as string;
      for (const a of b.aliases ?? []) {
        await c.query(
          `INSERT INTO nightclub.customer_aliases
             (tenant_id, store_id, customer_id, alias, alias_key)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [member.tenantId, storeId, id, a, nameKey(a)]);
      }
      await audit(c, g, {
        action: 'customer.create', targetType: 'customers', targetId: id,
        changes: { display_name: b.display_name }, traceId: req.traceId,
      });
      return ins.rows[0];
    });
    reply.code(201);
    return { id: row.id, display_name: b.display_name, version: row.version };
  });

  app.patch('/stores/:storeId/customers/:customerId', {
    schema: {
      params: params({ storeId: sUuid, customerId: sUuid }),
      body: body({
        expected_version: version, display_name: str(200),
        masked_hint: str(200),
      }, ['expected_version']),
    },
  }, async (req) => {
    const { storeId, customerId } = req.params as { storeId: string; customerId: string };
    const { g, member } = await customerCaller(req, storeId);
    requirePerm(member, 'customer.manage');
    const b = req.body as { expected_version?: number; display_name?: string; masked_hint?: string };
    if (typeof b?.expected_version !== 'number') throw E.invalid('expected_version required');
    return withCtx(g, async (c) => {
      const r = await c.query(
        `UPDATE nightclub.customers SET
            display_name = COALESCE($4, display_name),
            name_key = COALESCE($5, name_key),
            masked_hint = COALESCE($6, masked_hint),
            version = version + 1, updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND version=$7
          RETURNING version`,
        [member.tenantId, storeId, customerId, b.display_name ?? null,
         b.display_name ? nameKey(b.display_name) : null,
         b.masked_hint ?? null, b.expected_version]);
      if (!r.rows[0]) throw E.versionConflict();
      await audit(c, g, {
        action: 'customer.update', targetType: 'customers', targetId: customerId,
        changes: { display_name: b.display_name ?? null }, traceId: req.traceId,
      });
      return { resource_id: customerId, version: r.rows[0].version, status: 'UPDATED', trace_id: req.traceId };
    });
  });

  // Regular designation / revocation. Revocation surfaces active permits —
  // they are NOT silently removed (settings_and_rules.md §7).
  app.post('/stores/:storeId/customers/:customerId/regular-designation', {
    schema: {
      params: params({ storeId: sUuid, customerId: sUuid }),
      body: body({
        expected_version: version, designate: { type: 'boolean' },
        reason: str(1000), confirm: { type: 'boolean' },
      }, ['expected_version', 'designate']),
    },
  }, async (req) => {
    const { storeId, customerId } = req.params as { storeId: string; customerId: string };
    const { g, member } = await customerCaller(req, storeId);
    requirePerm(member, 'customer.designate');
    const b = req.body as {
      expected_version?: number; designate?: boolean; reason?: string; confirm?: boolean;
    };
    if (typeof b?.expected_version !== 'number' || typeof b.designate !== 'boolean') {
      throw E.invalid('expected_version and designate required');
    }
    return withCtx(g, async (c) => {
      if (!b.designate && !b.confirm) {
        const permits = await c.query(
          `SELECT id, permit_key, conditions, valid_from, valid_to
             FROM nightclub.permits
            WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3
              AND status='ACTIVE' AND valid_to > CURRENT_TIMESTAMP`,
          [member.tenantId, storeId, customerId]);
        if (permits.rows.length) {
          throw E.validation('active permits exist; confirm to proceed', [{
            path: 'designate', code: 'PERMITS_PRESENT',
            message: `${permits.rows.length} active permit(s) remain — review before revoking designation`,
          }]);
        }
      }
      const r = await c.query(
        `UPDATE nightclub.customers SET regular_status=$4,
            version=version+1, updated_at=CURRENT_TIMESTAMP
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND version=$5
          RETURNING version`,
        [member.tenantId, storeId, customerId,
         b.designate ? 'DESIGNATED' : 'REVOKED', b.expected_version]);
      if (!r.rows[0]) throw E.versionConflict();
      await audit(c, g, {
        action: b.designate ? 'customer.designate' : 'customer.revoke_regular',
        targetType: 'customers', targetId: customerId,
        reason: b.reason ?? null, traceId: req.traceId,
      });
      return {
        resource_id: customerId, version: r.rows[0].version,
        status: b.designate ? 'DESIGNATED' : 'REVOKED', trace_id: req.traceId,
      };
    });
  });
}
