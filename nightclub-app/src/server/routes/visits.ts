// Reception core: visits, segments, approval decisions, customer checks,
// entry, passes, corrections.
// Invariants enforced here:
//  - name search is never identity proof (customer_checks are explicit)
//  - entrance approval needs only: active operator session + assignment +
//    permission. No absence/wait/arrival/read conditions.
//  - first valid decision wins; later concurrent decisions -> ALREADY_DECIDED
//  - quota: hold at authorization, consume at first entry, release unentered
//    holds exactly once on cancel/expiry. Pending consumes nothing.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Guc, Client } from '../lib/db.js';
import { withCtx } from '../lib/db.js';
import { E } from '../lib/errors.js';
import { nameKey } from '../lib/namekey.js';
import { uuid, sha256 } from '../lib/crypto.js';
import {
  audit, emit, holdQuota, idemKey, withReceipt, publishedPolicy,
  type Policy,
} from '../lib/tx.js';
import { visitSummary } from '../lib/summary.js';
import {
  body, eventChild, eventParams, params, query, str, uuid as sUuid, version,
} from '../lib/schemas.js';
import {
  requirePersonal, requireOperator, requirePerm, eventAssignments, type MemberCtx, type OperatorCtx, type PersonalCtx, gucPersonal, gucOperator,
} from '../lib/ctx.js';
import { config } from '../config.js';

interface Caller {
  g: Guc; member: MemberCtx;
  operator?: OperatorCtx; personal?: PersonalCtx;
}

async function visitCaller(
  req: FastifyRequest, storeId: string, eventId: string,
  perm: string,
): Promise<Caller> {
  const op = await req.auth.operator().catch((e) => {
    if ((e as { code?: string }).code === 'OPERATOR_CHANGED') throw e;
    return null;
  });
  if (op) {
    if (op.storeId !== storeId || op.eventId !== eventId) throw E.forbidden('wrong store/event');
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

interface PermitRow {
  id: string; permit_key: string; customer_id: string | null;
  actor_membership_id: string | null; conditions: {
    event_ids: string[]; allowed_rule_keys: string[];
    party_limit: { mode: string; value: number | null };
    event_limit: { mode: string; value: number | null };
    companion_limit: { mode: string; value: number | null };
    principal_presence_required: boolean;
    proxy_registration_allowed: boolean;
    proxy_referrer_ids: string[];
  };
  valid_from: string; valid_to: string;
}

async function findPermits(
  c: Client, g: Guc, kind: 'CUSTOMER' | 'ACTOR', subjectId: string,
): Promise<PermitRow[]> {
  const col = kind === 'CUSTOMER' ? 'customer_id' : 'actor_membership_id';
  const r = await c.query(
    `SELECT id, permit_key, customer_id, actor_membership_id, conditions,
            valid_from, valid_to
       FROM nightclub.permits
      WHERE tenant_id=$1 AND store_id=$2 AND subject_kind=$3
        AND ${col}=$4 AND status='ACTIVE'
        AND valid_from <= CURRENT_TIMESTAMP AND valid_to > CURRENT_TIMESTAMP
      ORDER BY permit_key`,
    [g.tenantId, g.storeId, kind, subjectId]);
  return r.rows;
}

function permitMatches(
  p: PermitRow, args: {
    eventId: string; ruleKey: string; count: number; isProxy: boolean;
    referrerId: string | null;
  },
): { ok: boolean; reason?: string } {
  const cond = p.conditions;
  if (!cond.event_ids?.includes(args.eventId)) return { ok: false };
  if (!cond.allowed_rule_keys?.includes(args.ruleKey)) return { ok: false };
  const lim = (l: { mode: string; value: number | null }, need: number) =>
    l.mode === 'UNLIMITED' || (l.mode === 'LIMITED' && (l.value ?? 0) >= need);
  if (!lim(cond.party_limit, args.count)) return { ok: false, reason: 'party_limit' };
  if (cond.event_limit.mode === 'UNSET') return { ok: false, reason: 'event_limit_unset' };
  if (args.isProxy && !cond.proxy_registration_allowed) return { ok: false, reason: 'proxy' };
  if (args.isProxy && cond.proxy_referrer_ids.length
      && args.referrerId && !cond.proxy_referrer_ids.includes(args.referrerId)) {
    return { ok: false, reason: 'proxy_referrer' };
  }
  return { ok: true };
}

export default async function visitRoutes(app: FastifyInstance) {
  // ---- visit create ------------------------------------------------------
  app.post('/stores/:storeId/events/:eventId/visits', {
    schema: {
      params: eventParams,
      body: body({
        reception_name: str(200), reading: str(200),
        planned_count: { type: 'integer', minimum: 1, maximum: 200 },
        customer_id: { type: ['string', 'null'], format: 'uuid' },
        referrer_membership_id: { type: ['string', 'null'], format: 'uuid' },
        arrival_status: { type: 'string', enum: ['UNKNOWN', 'ON_WAY', 'ARRIVED'] },
        approval_reason: str(1000),
        segments: {
          type: 'array', minItems: 1, maxItems: 50,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              rule_key: str(100),
              count: { type: 'integer', minimum: 1, maximum: 200 },
              requested_customer_id: { type: ['string', 'null'], format: 'uuid' },
            },
            required: ['rule_key', 'count'],
          },
        },
      }, ['reception_name', 'planned_count', 'segments']),
    },
  }, async (req, reply) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string };
    const caller = await visitCaller(req, storeId, eventId, 'visit.create');
    const b = req.body as {
      reception_name?: string; reading?: string; planned_count?: number;
      customer_id?: string | null; referrer_membership_id?: string | null;
      arrival_status?: string; approval_reason?: string;
      segments?: { rule_key: string; count: number; requested_customer_id?: string | null }[];
    };
    if (!b?.reception_name || !b.planned_count || !Array.isArray(b.segments) || !b.segments.length) {
      throw E.invalid('reception_name, planned_count, segments required');
    }
    const receptionName = b.reception_name;
    const plannedCount = b.planned_count;
    const g = caller.g;
    const key = idemKey(req);
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: caller.operator?.sessionId ?? caller.member.membershipId,
      operation: 'visit.create', key, body: b, receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const ev = await c.query(
          `SELECT id, version, status, opens_at, closes_at FROM nightclub.events
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,
          [g.tenantId, g.storeId, eventId]);
        const event = ev.rows[0];
        if (!event) throw E.notFound('event');
        if (!['PUBLISHED', 'OPEN'].includes(event.status)) {
          throw E.invalid(`event not open for registration (${event.status})`);
        }
        const policy = await publishedPolicy(c, g, eventId);
        if (!policy) throw E.configIncomplete('no published policy');
        const ps = policy.settings;
        const now = new Date();
        if (now < new Date(ps.registration_from) || now > new Date(ps.registration_to)) {
          throw E.invalid('outside registration window');
        }
        if (ps.max_party_size.mode === 'UNSET') throw E.configIncomplete('max_party_size unset');
        if (ps.max_party_size.mode === 'LIMITED'
            && plannedCount > ps.max_party_size.value!) {
          throw E.validation('planned_count exceeds max_party_size', [{
            path: 'planned_count', code: 'MAX_PARTY',
            message: `limit ${ps.max_party_size.value}`,
          }]);
        }
        // Referrer scoping: referrers may only register under themselves.
        let referrerId = b.referrer_membership_id ?? null;
        if (caller.member.permissions.has('visit.create')) {
          const isStaff = memberIsStaff(caller.member);
          if (!isStaff) {
            if (referrerId && referrerId !== caller.member.membershipId) {
              throw E.forbidden('referrers register under own membership');
            }
            referrerId = caller.member.membershipId;
          }
        }
        if (b.customer_id) {
          const cu = await c.query(
            `SELECT id FROM nightclub.customers
              WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
            [g.tenantId, g.storeId, b.customer_id]);
          if (!cu.rows[0]) throw E.invalid('customer not found');
        }
        if (referrerId) {
          const rm = await c.query(
            `SELECT id FROM nightclub.memberships
              WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='ACTIVE'`,
            [g.tenantId, g.storeId, referrerId]);
          if (!rm.rows[0]) throw E.invalid('referrer not found');
        }
        const v = await c.query(
          `INSERT INTO nightclub.visits
             (tenant_id, store_id, event_id, customer_id, referrer_membership_id,
              created_by, source, reception_name, name_key, planned_count,
              arrival_status, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ACTIVE') RETURNING id`,
          [g.tenantId, g.storeId, eventId, b.customer_id ?? null, referrerId,
           caller.member.membershipId,
           caller.operator ? 'WALK_IN' : 'STAFF',
           receptionName, nameKey(receptionName), plannedCount,
           b.arrival_status ?? 'UNKNOWN']);
        const visitId = v.rows[0].id as string;
        // principal member row
        await c.query(
          `INSERT INTO nightclub.visit_members
             (tenant_id, store_id, event_id, visit_id, customer_id, display_name, member_kind)
           VALUES ($1,$2,$3,$4,$5,$6,'PRINCIPAL')`,
          [g.tenantId, g.storeId, eventId, visitId, b.customer_id ?? null, receptionName]);

        const isProxy = !!caller.personal
          && caller.member.permissions.has('visit.proxy')
          && referrerId !== caller.member.membershipId;

        for (const s of b.segments!) {
          const rule = ps.price_rules.find((r) => r.rule_key === s.rule_key);
          if (!rule) throw E.invalid(`unknown rule_key ${s.rule_key}`);
          if (!Number.isInteger(s.count) || s.count < 1) throw E.invalid('segment count');
          if (s.count > plannedCount) {
            throw E.invalid('segment count exceeds planned_count');
          }
          const requiredCustomer = s.requested_customer_id ?? null;
          if (requiredCustomer) {
            const cu = await c.query(
              `SELECT id FROM nightclub.customers
                WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
              [g.tenantId, g.storeId, requiredCustomer]);
            if (!cu.rows[0]) throw E.invalid('requested_customer not found');
          }
          const judged = await judgeSegment(c, g, {
            eventId, visitId, rule, count: s.count,
            requiredCustomer, visitCustomer: b.customer_id ?? null,
            actorMembership: caller.member.membershipId, referrerId, isProxy,
            policy: ps, approvalReason: b.approval_reason ?? null,
            currency: ps.currency,
          });
          const seg = await c.query(
            `INSERT INTO nightclub.admission_segments
               (tenant_id, store_id, event_id, visit_id, price_rule_id, permit_id,
                required_customer_id, requested_count, authorized_count,
                unit_amount_minor, currency, status, authorization_method,
                snapshot, entry_until)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             RETURNING id, version`,
            [g.tenantId, g.storeId, eventId, visitId, judged.priceRuleId,
             judged.permitId, requiredCustomer, s.count,
             judged.status === 'AUTHORIZED' ? s.count : 0,
             rule.amount_minor, ps.currency, judged.status,
             judged.method, JSON.stringify(judged.snapshot), rule.entry_to]);
          if (judged.buckets.length && judged.status === 'AUTHORIZED') {
            await holdQuota(c, g, {
              eventId, segmentId: seg.rows[0].id, buckets: judged.buckets, count: s.count,
            });
          }
          if (judged.status === 'PENDING') {
            await c.query(
              `INSERT INTO nightclub.approval_requests
                 (tenant_id, store_id, event_id, segment_id, requested_by,
                  request_version, segment_version, reason, status)
               VALUES ($1,$2,$3,$4,$5,1,$6,$7,'PENDING')`,
              [g.tenantId, g.storeId, eventId, seg.rows[0].id,
               caller.member.membershipId, seg.rows[0].version,
               b.approval_reason ?? 'manual approval required']);
          }
        }
        const summary = await visitSummary(c, g, visitId, eventId);
        await audit(c, g, {
          action: 'visit.create', targetType: 'visits', targetId: visitId,
          changes: { reception_name: receptionName, planned_count: plannedCount },
          traceId: req.traceId,
        });
        await emit(c, g, {
          eventId, eventType: 'visit.upserted', aggregateType: 'visit',
          aggregateId: visitId, aggregateVersion: 1,
          payload: { visit: summary }, traceId: req.traceId,
        });
        return { httpStatus: 201, body: summary };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- list / get --------------------------------------------------------
  app.get('/stores/:storeId/events/:eventId/visits', {
    schema: {
      params: eventParams,
      querystring: query({
        status: str(50), q: str(200),
        limit: { type: 'string', pattern: '^[0-9]+$', maxLength: 4 },
        cursor: sUuid,
      }),
    },
  }, async (req) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string };
    const q = req.query as { status?: string; q?: string; limit?: string; cursor?: string };
    const caller = await visitCaller(req, storeId, eventId, 'visit.read');
    const limit = Math.min(Number(q.limit) || 50, 200);
    return withCtx(caller.g, async (c) => {
      const conds = ['v.tenant_id=$1', 'v.store_id=$2', 'v.event_id=$3'];
      const params: unknown[] = [caller.g.tenantId, storeId, eventId];
      if (q.status) { params.push(q.status); conds.push(`v.status=$${params.length}`); }
      if (q.q) { params.push(nameKey(q.q)); conds.push(`v.name_key LIKE '%' || $${params.length} || '%'`); }
      if (q.cursor) { params.push(q.cursor); conds.push(`v.id > $${params.length}`); }
      params.push(limit + 1);
      const r = await c.query(
        `SELECT v.id FROM nightclub.visits v
          WHERE ${conds.join(' AND ')} ORDER BY v.created_at, v.id LIMIT $${params.length}`,
        params);
      const items = [];
      for (const row of r.rows.slice(0, limit)) {
        items.push(await visitSummary(c, caller.g, row.id, eventId));
      }
      return {
        items, has_more: r.rows.length > limit,
        next_cursor: r.rows.length > limit ? r.rows[limit - 1].id : null,
      };
    });
  });

  app.get('/stores/:storeId/events/:eventId/visits/:visitId', {
    schema: { params: eventChild('visitId') },
  }, async (req) => {
    const { storeId, eventId, visitId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const caller = await visitCaller(req, storeId, eventId, 'visit.read');
    return withCtx(caller.g, async (c) => {
      const s = await visitSummary(c, caller.g, visitId, eventId);
      if (!s) throw E.notFound('visit');
      return s;
    });
  });

  app.patch('/stores/:storeId/events/:eventId/visits/:visitId', {
    schema: {
      params: eventChild('visitId'),
      body: body({
        expected_version: version, reception_name: str(200),
        arrival_status: { type: 'string', enum: ['UNKNOWN', 'ON_WAY', 'ARRIVED'] },
      }, ['expected_version']),
    },
  }, async (req, reply) => {
    const { storeId, eventId, visitId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const caller = await visitCaller(req, storeId, eventId, 'visit.edit');
    const b = req.body as {
      expected_version?: number; reception_name?: string;
      arrival_status?: string;
    };
    if (typeof b?.expected_version !== 'number') throw E.invalid('expected_version required');
    const g = caller.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: caller.operator?.sessionId ?? caller.member.membershipId,
      operation: 'visit.update', key: idemKey(req), body: b,
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const r = await c.query(
          `UPDATE nightclub.visits SET
             reception_name = COALESCE($5, reception_name),
             name_key = COALESCE($6, name_key),
             arrival_status = COALESCE($7, arrival_status),
             version = version + 1, updated_at = CURRENT_TIMESTAMP
           WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
             AND version=$8 AND status='ACTIVE'
           RETURNING version`,
          [g.tenantId, g.storeId, eventId, visitId,
           b.reception_name ?? null,
           b.reception_name ? nameKey(b.reception_name) : null,
           b.arrival_status ?? null, b.expected_version]);
        if (!r.rows[0]) throw E.versionConflict();
        const summary = await visitSummary(c, g, visitId, eventId);
        await emit(c, g, {
          eventId, eventType: 'visit.upserted', aggregateType: 'visit',
          aggregateId: visitId, aggregateVersion: r.rows[0].version,
          payload: { visit: summary }, traceId: req.traceId,
        });
        await audit(c, g, {
          action: 'visit.update', targetType: 'visits', targetId: visitId,
          changes: b, traceId: req.traceId,
        });
        return { httpStatus: 200, body: summary };
      },
    }));
    void res;
    reply.code(res.httpStatus);
    return res.body;
  });

  // Cancel: release only unentered held quota, exactly once.
  app.post('/stores/:storeId/events/:eventId/visits/:visitId/cancel', {
    schema: {
      params: eventChild('visitId'),
      body: body({ expected_version: version, reason: str(1000) }),
    },
  }, async (req, reply) => {
    const { storeId, eventId, visitId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const caller = await visitCaller(req, storeId, eventId, 'visit.cancel');
    const b = (req.body ?? {}) as { expected_version?: number; reason?: string };
    const g = caller.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: caller.operator?.sessionId ?? caller.member.membershipId,
      operation: 'visit.cancel', key: idemKey(req), body: b,
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const v = await c.query(
          `SELECT id, version, status FROM nightclub.visits
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
            FOR UPDATE`, [g.tenantId, g.storeId, eventId, visitId]);
        if (!v.rows[0]) throw E.notFound('visit');
        if (v.rows[0].status !== 'ACTIVE') throw E.invalid('visit not active');
        const segs = await c.query(
          `SELECT id, status, authorized_count, first_entered_count
             FROM nightclub.admission_segments
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND visit_id=$4
            FOR UPDATE`, [g.tenantId, g.storeId, eventId, visitId]);
        for (const s of segs.rows) {
          const unentered = s.authorized_count - s.first_entered_count;
          if (s.status === 'AUTHORIZED' && unentered > 0) {
            await releaseHold(c, g, eventId, s.id, unentered);
          }
          if (['PENDING', 'AUTHORIZED'].includes(s.status)) {
            await c.query(
              `UPDATE nightclub.admission_segments SET status='REVOKED',
                  version=version+1, updated_at=CURRENT_TIMESTAMP
                WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
              [g.tenantId, g.storeId, eventId, s.id]);
          }
          await c.query(
            `UPDATE nightclub.approval_requests SET status='SUPERSEDED',
                version=version+1, updated_at=CURRENT_TIMESTAMP
              WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3
                AND segment_id=$4 AND status='PENDING'`,
            [g.tenantId, g.storeId, eventId, s.id]);
        }
        await c.query(
          `UPDATE nightclub.visits SET status='CANCELED', version=version+1,
              updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [g.tenantId, g.storeId, eventId, visitId]);
        const summary = await visitSummary(c, g, visitId, eventId);
        await emit(c, g, {
          eventId, eventType: 'visit.upserted', aggregateType: 'visit',
          aggregateId: visitId, aggregateVersion: v.rows[0].version + 1,
          payload: { visit: summary }, traceId: req.traceId,
        });
        await audit(c, g, {
          action: 'visit.cancel', targetType: 'visits', targetId: visitId,
          reason: b.reason ?? null, traceId: req.traceId,
        });
        return { httpStatus: 200, body: summary };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- approvals ----------------------------------------------------------
  app.get('/stores/:storeId/events/:eventId/approvals', {
    schema: {
      params: eventParams,
      querystring: query({ status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED', 'RETURNED', 'SUPERSEDED'] } }),
    },
  }, async (req) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const caller = await visitCaller(req, storeId, eventId, 'approval.read');
    const q = req.query as { status?: string };
    return withCtx(caller.g, async (c) => {
      const r = await c.query(
        `SELECT ar.id, ar.version, ar.status, ar.request_version,
                ar.segment_version, ar.reason, ar.created_at,
                ar.requested_by, rm.display_name AS requested_by_name,
                s.id AS segment_id, s.requested_count, s.unit_amount_minor,
                s.currency, s.authorization_method, s.snapshot,
                v.id AS visit_id, v.reception_name
           FROM nightclub.approval_requests ar
           JOIN nightclub.admission_segments s
             ON s.tenant_id=ar.tenant_id AND s.store_id=ar.store_id
            AND s.event_id=ar.event_id AND s.id=ar.segment_id
           JOIN nightclub.visits v
             ON v.tenant_id=ar.tenant_id AND v.store_id=ar.store_id
            AND v.event_id=ar.event_id AND v.id=s.visit_id
           LEFT JOIN nightclub.memberships rm
             ON rm.tenant_id=ar.tenant_id AND rm.store_id=ar.store_id
            AND rm.id=ar.requested_by
          WHERE ar.tenant_id=$1 AND ar.store_id=$2 AND ar.event_id=$3
            AND ($4::text IS NULL OR ar.status=$4)
          ORDER BY ar.created_at`,
        [caller.g.tenantId, storeId, eventId, q.status ?? null]);
      return { items: r.rows };
    });
  });

  // First valid decision wins. Entrance staff approve normally (no
  // absence/wait/arrival preconditions — policy entrance_regular_approval).
  app.post('/stores/:storeId/events/:eventId/approvals/:requestId/decisions', {
    schema: {
      params: eventChild('requestId'),
      body: body({
        expected_request_version: version, expected_segment_version: version,
        decision: { type: 'string', enum: ['APPROVED', 'REJECTED', 'RETURNED'] },
        reason: str(1000),
      }, ['expected_request_version', 'expected_segment_version', 'decision']),
    },
  }, async (req, reply) => {
    const { storeId, eventId, requestId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const caller = await visitCaller(req, storeId, eventId, 'approval.decide');
    const b = req.body as {
      expected_request_version?: number; expected_segment_version?: number;
      decision?: 'APPROVED' | 'REJECTED' | 'RETURNED'; reason?: string;
    };
    if (typeof b?.expected_request_version !== 'number'
        || typeof b.expected_segment_version !== 'number'
        || !['APPROVED', 'REJECTED', 'RETURNED'].includes(b.decision ?? '')) {
      throw E.invalid('expected versions and decision required');
    }
    const g = caller.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: caller.operator?.sessionId ?? caller.member.membershipId,
      operation: 'approval.decide', key: idemKey(req),
      body: { ...b, requestId }, receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const policy = await publishedPolicy(c, g, eventId);
        const route = caller.operator ? 'ENTRANCE' : 'DESIGNATED';
        // Route gate: entrance needs an event assignment; personal needs
        // designated-approver assignment or management permission.
        if (caller.operator) {
          const asg = await eventAssignments(c, caller.member, eventId);
          if (!asg.has('ENTRANCE') && !asg.has('ENTRANCE_APPROVER')) {
            throw E.forbidden('no entrance assignment');
          }
          if (policy && !policy.settings.approval.entrance_regular_approval) {
            throw E.forbidden('entrance approval disabled');
          }
        } else {
          const asg = await eventAssignments(c, caller.member, eventId);
          const designated = asg.has('DESIGNATED_APPROVER') || asg.has('ENTRANCE_APPROVER');
          if (!designated && !caller.member.permissions.has('policy.manage')) {
            throw E.forbidden('not a designated approver');
          }
        }
        const rr = await c.query(
          `SELECT id, version, status, segment_id, requested_by
             FROM nightclub.approval_requests
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
            FOR UPDATE`, [g.tenantId, g.storeId, eventId, requestId]);
        const req0 = rr.rows[0];
        if (!req0) throw E.notFound('approval request');
        if (req0.status !== 'PENDING') throw E.alreadyDecided();
        if (req0.version !== b.expected_request_version) {
          throw E.versionConflict(req0.version);
        }
        const sg = await c.query(
          `SELECT id, version, status, requested_count, unit_amount_minor, snapshot
             FROM nightclub.admission_segments
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
            FOR UPDATE`, [g.tenantId, g.storeId, eventId, req0.segment_id]);
        const seg = sg.rows[0];
        if (!seg || seg.version !== b.expected_segment_version) {
          throw E.versionConflict(seg?.version ?? null);
        }
        if (seg.status !== 'PENDING') throw E.alreadyDecided();
        if (req0.requested_by === caller.member.membershipId
            && !(policy?.settings.approval.self_approval_allowed)) {
          throw E.selfApproval();
        }
        const decisionId = uuid();
        await c.query(
          `INSERT INTO nightclub.approval_decisions
             (id, tenant_id, store_id, event_id, request_id, decided_by,
              operator_session_id, route, decision, reason, operation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [decisionId, g.tenantId, g.storeId, eventId, requestId,
           caller.member.membershipId, caller.operator?.sessionId ?? null,
           route, b.decision, b.reason ?? null, uuid()]);
        await c.query(
          `UPDATE nightclub.approval_requests SET status=$5, version=version+1,
              updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [g.tenantId, g.storeId, eventId, requestId, b.decision]);
        if (b.decision === 'APPROVED') {
          await c.query(
            `UPDATE nightclub.admission_segments
                SET status='AUTHORIZED', authorized_count=requested_count,
                    authorization_method='MANUAL',
                    version=version+1, updated_at=CURRENT_TIMESTAMP
              WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
            [g.tenantId, g.storeId, eventId, seg.id]);
          const buckets: { key: string; kind: string; limitMode: 'LIMITED' | 'UNLIMITED'; limit: number | null }[] =
            [{ key: 'manual', kind: 'MANUAL_DECIDER', limitMode: 'UNLIMITED', limit: null }];
          if (Number(seg.unit_amount_minor) === 0) {
            buckets.push({ key: 'event_free', kind: 'EVENT_HARD', limitMode: 'LIMITED', limit: null });
          }
          await holdQuota(c, g, {
            eventId, segmentId: seg.id, buckets, count: seg.requested_count,
          });
        } else {
          await c.query(
            `UPDATE nightclub.admission_segments SET status=$5,
                version=version+1, updated_at=CURRENT_TIMESTAMP
              WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
            [g.tenantId, g.storeId, eventId, seg.id,
             b.decision === 'REJECTED' ? 'REJECTED' : 'RETURNED']);
        }
        const visit = await c.query(
          `SELECT visit_id FROM nightclub.admission_segments
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [g.tenantId, g.storeId, eventId, seg.id]);
        const summary = await visitSummary(c, g, visit.rows[0].visit_id, eventId);
        await emit(c, g, {
          eventId, eventType: 'approval.decided', aggregateType: 'approval_request',
          aggregateId: requestId, aggregateVersion: req0.version + 1,
          payload: { decision: b.decision, route, visit: summary },
          traceId: req.traceId,
        });
        await audit(c, g, {
          action: 'approval.decide', targetType: 'approval_requests',
          targetId: requestId, changes: { decision: b.decision, route },
          reason: b.reason ?? null, traceId: req.traceId,
        });
        return {
          httpStatus: 200,
          body: {
            decision_id: decisionId, request_id: requestId,
            decision: b.decision, route, decided_by: caller.member.membershipId,
            segment: summary?.segments.find((x) => x.id === seg.id),
            trace_id: req.traceId,
          },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- customer identity check (never implied by name match) --------------
  app.post('/stores/:storeId/events/:eventId/visits/:visitId/customer-checks', {
    schema: {
      params: eventChild('visitId'),
      body: body({
        customer_id: sUuid, method: str(50), note: str(1000),
      }, ['customer_id', 'method']),
    },
  }, async (req, reply) => {
    const { storeId, eventId, visitId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const caller = await visitCaller(req, storeId, eventId, 'entrance.match');
    const b = req.body as { customer_id?: string; method?: string; note?: string };
    if (!b?.customer_id || !b.method) throw E.invalid('customer_id and method required');
    const g = caller.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: caller.operator?.sessionId ?? caller.member.membershipId,
      operation: 'customer.check', key: idemKey(req), body: { ...b, visitId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const policy = await publishedPolicy(c, g, eventId);
        if (policy && !policy.settings.customer_match_methods.includes(b.method!)) {
          throw E.validation('method not enabled', [{
            path: 'method', code: 'DISABLED', message: 'method disabled by policy',
          }]);
        }
        const v = await c.query(
          `SELECT id FROM nightclub.visits
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4 AND status='ACTIVE'`,
          [g.tenantId, g.storeId, eventId, visitId]);
        if (!v.rows[0]) throw E.notFound('visit');
        const cu = await c.query(
          `SELECT id FROM nightclub.customers
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
          [g.tenantId, g.storeId, b.customer_id]);
        if (!cu.rows[0]) throw E.invalid('customer not in this store');
        const ev = await c.query(
          `SELECT closes_at FROM nightclub.events
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
          [g.tenantId, g.storeId, eventId]);
        const ins = await c.query(
          `INSERT INTO nightclub.customer_checks
             (tenant_id, store_id, event_id, visit_id, customer_id, checked_by,
              operator_session_id, method, note, valid_until)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [g.tenantId, g.storeId, eventId, visitId, b.customer_id,
           caller.member.membershipId, caller.operator?.sessionId ?? null,
           b.method, b.note ?? null, ev.rows[0].closes_at]);
        await emit(c, g, {
          eventId, eventType: 'customer.checked', aggregateType: 'visit',
          aggregateId: visitId, aggregateVersion: 1,
          payload: { customer_check_id: ins.rows[0].id, customer_id: b.customer_id },
          traceId: req.traceId,
        });
        await audit(c, g, {
          action: 'customer.check', targetType: 'visits', targetId: visitId,
          changes: { customer_id: b.customer_id, method: b.method },
          traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: { customer_check_id: ins.rows[0].id, accepted: true, trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- entry (partial admission allowed) ----------------------------------
  app.post('/stores/:storeId/events/:eventId/visits/:visitId/entries', {
    schema: {
      params: eventChild('visitId'),
      body: body({
        expected_visit_version: version,
        selections: {
          type: 'array', minItems: 1, maxItems: 50,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              segment_id: sUuid,
              count: { type: 'integer', minimum: 1, maximum: 200 },
            },
            required: ['segment_id', 'count'],
          },
        },
        payment_ids: { type: 'array', maxItems: 50, items: sUuid },
        pass_id: { type: ['string', 'null'], format: 'uuid' },
      }, ['expected_visit_version', 'selections']),
    },
  }, async (req, reply) => {
    const { storeId, eventId, visitId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const caller = await visitCaller(req, storeId, eventId, 'entrance.checkin');
    const b = req.body as {
      expected_visit_version?: number;
      selections?: { segment_id: string; count: number }[];
      payment_ids?: string[]; pass_id?: string | null;
    };
    if (typeof b?.expected_visit_version !== 'number'
        || !Array.isArray(b.selections) || !b.selections.length) {
      throw E.invalid('expected_visit_version and selections required');
    }
    const g = caller.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: caller.operator?.sessionId ?? caller.member.membershipId,
      operation: 'entry.create', key: idemKey(req), body: { ...b, visitId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const v = await c.query(
          `SELECT id, version, status FROM nightclub.visits
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
            FOR UPDATE`, [g.tenantId, g.storeId, eventId, visitId]);
        if (!v.rows[0]) throw E.notFound('visit');
        if (v.rows[0].status !== 'ACTIVE') throw E.invalid('visit not active');
        if (v.rows[0].version !== b.expected_visit_version) {
          throw E.versionConflict(v.rows[0].version);
        }
        const opId = uuid();
        const entryIds: string[] = [];
        for (const sel of b.selections!) {
          if (!Number.isInteger(sel.count) || sel.count < 1) throw E.invalid('count');
          const sg = await c.query(
            `SELECT s.*, p.payment_required
               FROM nightclub.admission_segments s
               LEFT JOIN nightclub.price_rules p
                 ON p.tenant_id=s.tenant_id AND p.store_id=s.store_id
                AND p.event_id=s.event_id AND p.id=s.price_rule_id
              WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.event_id=$3
                AND s.id=$4 AND s.visit_id=$5 FOR UPDATE OF s`,
            [g.tenantId, g.storeId, eventId, sel.segment_id, visitId]);
          const seg = sg.rows[0];
          if (!seg) throw E.notFound('segment');
          if (seg.status !== 'AUTHORIZED') throw E.invalid(`segment ${sel.segment_id} not authorized`);
          if (new Date(seg.entry_until) <= new Date()) {
            throw E.invalid('entry window closed');
          }
          const remaining = seg.authorized_count - seg.first_entered_count;
          if (sel.count > remaining) throw E.entryCountExceeded();
          // Identity confirmation: required when the segment binds a customer
          // or its permit requires the principal.
          const needsCheck = !!seg.required_customer_id
            || (seg.snapshot as { requires_identity_check?: boolean })?.requires_identity_check === true;
          let checkId: string | null = null;
          if (needsCheck) {
            const cust = seg.required_customer_id
              ?? (await c.query(
                `SELECT customer_id FROM nightclub.visits
                  WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
                [g.tenantId, g.storeId, eventId, visitId])).rows[0]?.customer_id;
            const chk = await c.query(
              `SELECT id FROM nightclub.customer_checks
                WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3
                  AND visit_id=$4 AND customer_id=$5 AND revoked_at IS NULL
                  AND valid_until > CURRENT_TIMESTAMP
                ORDER BY created_at DESC LIMIT 1`,
              [g.tenantId, g.storeId, eventId, visitId, cust]);
            if (!chk.rows[0]) throw E.identityRequired();
            checkId = chk.rows[0].id;
          }
          // Payment: price rule requiring payment must be covered by
          // succeeded payments on this visit's admission order.
          const due = Number(seg.unit_amount_minor) * sel.count;
          if (seg.payment_required && due > 0) {
            const paid = await c.query(
              `SELECT COALESCE(SUM(pa.amount_minor),0)::bigint AS total
                 FROM nightclub.payment_allocations pa
                 JOIN nightclub.payments p
                   ON p.tenant_id=pa.tenant_id AND p.store_id=pa.store_id
                  AND p.event_id=pa.event_id AND p.id=pa.payment_id
                WHERE pa.tenant_id=$1 AND pa.store_id=$2 AND pa.event_id=$3
                  AND pa.order_id IN (
                    SELECT id FROM nightclub.sales_orders
                     WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3
                       AND visit_id=$4 AND kind='ADMISSION')
                  AND p.status='SUCCEEDED'`,
              [g.tenantId, g.storeId, eventId, visitId]);
            if (Number(paid.rows[0].total) < due) throw E.paymentRequired();
          }
          await c.query(
            `UPDATE nightclub.admission_segments
                SET first_entered_count = first_entered_count + $5,
                    version = version + 1, updated_at = CURRENT_TIMESTAMP
              WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
            [g.tenantId, g.storeId, eventId, seg.id, sel.count]);
          await consumeHold(c, g, eventId, seg.id, sel.count);
          const en = await c.query(
            `INSERT INTO nightclub.admission_events
               (tenant_id, store_id, event_id, visit_id, segment_id, pass_id,
                operator_session_id, actor_membership_id, customer_check_id,
                kind, quantity, present_delta, first_entry_delta,
                operation_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'FIRST_ENTRY',$10,$10,$10,$11)
             RETURNING id`,
            [g.tenantId, g.storeId, eventId, visitId, seg.id,
             b.pass_id ?? null, caller.operator?.sessionId ?? null,
             caller.member.membershipId, checkId, sel.count, opId]);
          entryIds.push(en.rows[0].id);
          if (due > 0) {
            await recordAdmissionSale(c, g, {
              eventId, visitId, segmentId: seg.id, count: sel.count,
              unit: Number(seg.unit_amount_minor), currency: seg.currency,
              operationId: opId,
            });
          }
        }
        // Group pass for re-entry (GROUP_LOOKUP).
        await c.query(
          `INSERT INTO nightclub.entry_passes
             (tenant_id, store_id, event_id, visit_id, member_id, token_hash,
              pass_kind, presence, expires_at)
           SELECT $1,$2,$3,$4, vm.id, $5, 'GROUP_LOOKUP', 'INSIDE',
                  (SELECT closes_at FROM nightclub.events
                    WHERE tenant_id=$1 AND store_id=$2 AND id=$3)
             FROM nightclub.visit_members vm
            WHERE vm.tenant_id=$1 AND vm.store_id=$2 AND vm.event_id=$3
              AND vm.visit_id=$4 AND vm.member_kind='PRINCIPAL'
           ON CONFLICT (token_hash) DO NOTHING`,
          [g.tenantId, g.storeId, eventId, visitId,
           `pass:${visitId}:${opId}`]);
        await c.query(
          `UPDATE nightclub.visits SET arrival_status='ARRIVED',
              version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [g.tenantId, g.storeId, eventId, visitId]);
        const summary = await visitSummary(c, g, visitId, eventId);
        await emit(c, g, {
          eventId, eventType: 'entry.recorded', aggregateType: 'visit',
          aggregateId: visitId, aggregateVersion: (v.rows[0].version as number) + 1,
          payload: { visit: summary, entry_ids: entryIds }, traceId: req.traceId,
        });
        await audit(c, g, {
          action: 'entry.create', targetType: 'visits', targetId: visitId,
          changes: { selections: b.selections }, traceId: req.traceId,
        });
        return {
          httpStatus: 200,
          body: { entry_ids: entryIds, visit: summary, trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- additional segment on an existing visit (F-015) --------------------
  // Same adjudication path as visit.create (rule -> permit/standard/manual),
  // locked on the visit row so entry/cancel interleavings stay consistent.
  app.post('/stores/:storeId/events/:eventId/visits/:visitId/segments', {
    schema: {
      params: eventChild('visitId'),
      body: body({
        expected_visit_version: version,
        rule_key: str(100),
        count: { type: 'integer', minimum: 1, maximum: 200 },
        requested_customer_id: { type: ['string', 'null'], format: 'uuid' },
        approval_reason: str(1000),
      }, ['expected_visit_version', 'rule_key', 'count']),
    },
  }, async (req, reply) => {
    const { storeId, eventId, visitId } = req.params as { storeId: string; eventId: string; visitId: string };
    const caller = await visitCaller(req, storeId, eventId, 'visit.edit');
    const b = req.body as {
      expected_visit_version?: number; rule_key?: string; count?: number;
      requested_customer_id?: string | null; approval_reason?: string;
    };
    const g = caller.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: caller.operator?.sessionId ?? caller.member.membershipId,
      operation: 'visit.segment.add', key: idemKey(req), body: { ...b, visitId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const v = await c.query(
          `SELECT id, version, status, customer_id, referrer_membership_id
             FROM nightclub.visits
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
            FOR UPDATE`, [g.tenantId, g.storeId, eventId, visitId]);
        const visit = v.rows[0];
        if (!visit) throw E.notFound('visit');
        if (visit.status !== 'ACTIVE') throw E.invalid('visit not active');
        if (visit.version !== b.expected_visit_version) {
          throw E.versionConflict(visit.version);
        }
        const policy = await publishedPolicy(c, g, eventId);
        if (!policy) throw E.configIncomplete('no published policy');
        const ps = policy.settings;
        const rule = ps.price_rules.find((r) => r.rule_key === b.rule_key);
        if (!rule) throw E.invalid(`unknown rule_key ${b.rule_key}`);
        const totalPlanned = await c.query(
          `SELECT planned_count FROM nightclub.visits
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [g.tenantId, g.storeId, eventId, visitId]);
        if (b.count! > (totalPlanned.rows[0]?.planned_count ?? 0)) {
          throw E.invalid('segment count exceeds planned_count');
        }
        const requiredCustomer = b.requested_customer_id ?? null;
        if (requiredCustomer) {
          const cu = await c.query(
            `SELECT id FROM nightclub.customers
              WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
            [g.tenantId, g.storeId, requiredCustomer]);
          if (!cu.rows[0]) throw E.invalid('requested_customer not found');
        }
        const isProxy = !!caller.personal
          && caller.member.permissions.has('visit.proxy')
          && visit.referrer_membership_id !== caller.member.membershipId;
        const judged = await judgeSegment(c, g, {
          eventId, visitId, rule, count: b.count!,
          requiredCustomer, visitCustomer: visit.customer_id,
          actorMembership: caller.member.membershipId,
          referrerId: visit.referrer_membership_id, isProxy,
          policy: ps, approvalReason: b.approval_reason ?? null,
          currency: ps.currency,
        });
        const seg = await c.query(
          `INSERT INTO nightclub.admission_segments
             (tenant_id, store_id, event_id, visit_id, price_rule_id, permit_id,
              required_customer_id, requested_count, authorized_count,
              unit_amount_minor, currency, status, authorization_method,
              snapshot, entry_until)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING id, version`,
          [g.tenantId, g.storeId, eventId, visitId, judged.priceRuleId,
           judged.permitId, requiredCustomer, b.count,
           judged.status === 'AUTHORIZED' ? b.count : 0,
           rule.amount_minor, ps.currency, judged.status,
           judged.method, JSON.stringify(judged.snapshot), rule.entry_to]);
        if (judged.buckets.length && judged.status === 'AUTHORIZED') {
          await holdQuota(c, g, {
            eventId, segmentId: seg.rows[0].id,
            buckets: judged.buckets, count: b.count!,
          });
        }
        if (judged.status === 'PENDING') {
          await c.query(
            `INSERT INTO nightclub.approval_requests
               (tenant_id, store_id, event_id, segment_id, requested_by,
                request_version, segment_version, reason, status)
             VALUES ($1,$2,$3,$4,$5,1,$6,$7,'PENDING')`,
            [g.tenantId, g.storeId, eventId, seg.rows[0].id,
             caller.member.membershipId, seg.rows[0].version,
             b.approval_reason ?? 'manual approval required']);
        }
        const summary = await visitSummary(c, g, visitId, eventId);
        await emit(c, g, {
          eventId, eventType: 'visit.upserted', aggregateType: 'visit',
          aggregateId: visitId, aggregateVersion: visit.version,
          payload: { visit: summary }, traceId: req.traceId,
        });
        await audit(c, g, {
          action: 'visit.segment.add', targetType: 'admission_segments',
          targetId: seg.rows[0].id,
          changes: { rule_key: b.rule_key, count: b.count },
          traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: {
            segment_id: seg.rows[0].id, status: judged.status,
            visit: summary, trace_id: req.traceId,
          },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- replace the un-entered portion of a segment with a new request ----
  // The entered part stays on the original segment; the remainder is revoked
  // (or truncated) and re-requested under the new rule_key/count, which goes
  // through the same judge (permit -> authorized, else manual approval).
  app.post('/stores/:storeId/events/:eventId/segments/:segmentId/replace', {
    schema: {
      params: eventChild('segmentId'),
      body: body({
        expected_version: version,
        rule_key: str(40),
        count: { type: 'integer', minimum: 1, maximum: 200 },
        reason: str(500),
      }, ['expected_version', 'rule_key', 'count', 'reason']),
    },
  }, async (req, reply) => {
    const { storeId, eventId, segmentId } = req.params as { storeId: string; eventId: string; segmentId: string };
    const caller = await visitCaller(req, storeId, eventId, 'visit.edit');
    const b = req.body as {
      expected_version?: number; rule_key?: string; count?: number; reason?: string;
    };
    const g = caller.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: caller.operator?.sessionId ?? caller.member.membershipId,
      operation: 'visit.segment.replace', key: idemKey(req),
      body: { ...b, segmentId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const s = await c.query(
          `SELECT id, version, status, visit_id, requested_count,
                  authorized_count, first_entered_count, required_customer_id
             FROM nightclub.admission_segments
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
            FOR UPDATE`, [g.tenantId, g.storeId, eventId, segmentId]);
        const seg = s.rows[0];
        if (!seg) throw E.notFound('segment');
        if (seg.version !== b.expected_version) throw E.versionConflict(seg.version);
        if (seg.status !== 'PENDING' && seg.status !== 'AUTHORIZED') {
          throw E.invalid(`segment ${seg.status} cannot be replaced`);
        }
        const entered = seg.first_entered_count as number;
        if (seg.requested_count - entered <= 0) {
          throw E.invalid('no un-entered portion to replace');
        }
        const v = await c.query(
          `SELECT id, version, status, customer_id, referrer_membership_id
             FROM nightclub.visits
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
            FOR UPDATE`, [g.tenantId, g.storeId, eventId, seg.visit_id]);
        const visit = v.rows[0];
        if (!visit) throw E.notFound('visit');
        if (visit.status !== 'ACTIVE') throw E.invalid('visit not active');
        const policy = await publishedPolicy(c, g, eventId);
        if (!policy) throw E.configIncomplete('no published policy');
        const ps = policy.settings;
        const rule = ps.price_rules.find((r) => r.rule_key === b.rule_key);
        if (!rule) throw E.invalid(`unknown rule_key ${b.rule_key}`);
        if (seg.status === 'AUTHORIZED') {
          await releaseHold(c, g, eventId, segmentId,
            (seg.authorized_count as number) - entered);
        }
        await c.query(
          `UPDATE nightclub.approval_requests SET status='SUPERSEDED',
              version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3
              AND segment_id=$4 AND status='PENDING'`,
          [g.tenantId, g.storeId, eventId, segmentId]);
        if (entered === 0) {
          await c.query(
            `UPDATE nightclub.admission_segments
                SET status='REVOKED', authorized_count=0,
                    version=version+1, updated_at=CURRENT_TIMESTAMP
              WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
            [g.tenantId, g.storeId, eventId, segmentId]);
        } else {
          await c.query(
            `UPDATE nightclub.admission_segments
                SET requested_count=$5, authorized_count=$5,
                    version=version+1, updated_at=CURRENT_TIMESTAMP
              WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
            [g.tenantId, g.storeId, eventId, segmentId, entered]);
        }
        const isProxy = !!caller.personal
          && caller.member.permissions.has('visit.proxy')
          && visit.referrer_membership_id !== caller.member.membershipId;
        const judged = await judgeSegment(c, g, {
          eventId, visitId: seg.visit_id, rule, count: b.count!,
          requiredCustomer: seg.required_customer_id,
          visitCustomer: visit.customer_id,
          actorMembership: caller.member.membershipId,
          referrerId: visit.referrer_membership_id, isProxy,
          policy: ps, approvalReason: b.reason ?? null,
          currency: ps.currency,
        });
        const nseg = await c.query(
          `INSERT INTO nightclub.admission_segments
             (tenant_id, store_id, event_id, visit_id, price_rule_id, permit_id,
              required_customer_id, requested_count, authorized_count,
              unit_amount_minor, currency, status, authorization_method,
              snapshot, entry_until)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING id, version`,
          [g.tenantId, g.storeId, eventId, seg.visit_id, judged.priceRuleId,
           judged.permitId, seg.required_customer_id, b.count,
           judged.status === 'AUTHORIZED' ? b.count : 0,
           rule.amount_minor, ps.currency, judged.status,
           judged.method, JSON.stringify(judged.snapshot), rule.entry_to]);
        if (judged.buckets.length && judged.status === 'AUTHORIZED') {
          await holdQuota(c, g, {
            eventId, segmentId: nseg.rows[0].id,
            buckets: judged.buckets, count: b.count!,
          });
        }
        if (judged.status === 'PENDING') {
          await c.query(
            `INSERT INTO nightclub.approval_requests
               (tenant_id, store_id, event_id, segment_id, requested_by,
                request_version, segment_version, reason, status)
             VALUES ($1,$2,$3,$4,$5,1,$6,$7,'PENDING')`,
            [g.tenantId, g.storeId, eventId, nseg.rows[0].id,
             caller.member.membershipId, nseg.rows[0].version,
             b.reason ?? 'manual approval required']);
        }
        const summary = await visitSummary(c, g, seg.visit_id, eventId);
        await emit(c, g, {
          eventId, eventType: 'visit.upserted', aggregateType: 'visit',
          aggregateId: seg.visit_id, aggregateVersion: visit.version,
          payload: { visit: summary }, traceId: req.traceId,
        });
        await audit(c, g, {
          action: 'visit.segment.replace', targetType: 'admission_segments',
          targetId: segmentId,
          changes: {
            replacement_segment_id: nseg.rows[0].id,
            rule_key: b.rule_key, count: b.count,
          },
          reason: b.reason ?? null, traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: {
            segment_id: nseg.rows[0].id, replaced_segment_id: segmentId,
            status: judged.status, visit: summary, trace_id: req.traceId,
          },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- correct the referrer attribution of a visit (reason required) ------
  // Re-points the visit and any sales_attributions on its order lines to the
  // new referrer; lines with no attribution gain one when a referrer is set.
  app.post('/stores/:storeId/events/:eventId/visits/:visitId/attribution', {
    schema: {
      params: eventChild('visitId'),
      body: body({
        expected_version: version,
        referrer_membership_id: sUuid,
        reason: str(500),
      }, ['expected_version', 'referrer_membership_id', 'reason']),
    },
  }, async (req, reply) => {
    const { storeId, eventId, visitId } = req.params as { storeId: string; eventId: string; visitId: string };
    const caller = await visitCaller(req, storeId, eventId, 'attribution.manage');
    const b = req.body as {
      expected_version?: number; referrer_membership_id?: string; reason?: string;
    };
    const g = caller.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: caller.operator?.sessionId ?? caller.member.membershipId,
      operation: 'visit.attribution', key: idemKey(req),
      body: { ...b, visitId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const v = await c.query(
          `SELECT id, version, status, referrer_membership_id
             FROM nightclub.visits
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
            FOR UPDATE`, [g.tenantId, g.storeId, eventId, visitId]);
        const visit = v.rows[0];
        if (!visit) throw E.notFound('visit');
        if (visit.version !== b.expected_version) {
          throw E.versionConflict(visit.version);
        }
        if (visit.status !== 'ACTIVE') throw E.invalid('visit not active');
        if (visit.referrer_membership_id === b.referrer_membership_id) {
          throw E.invalid('attribution unchanged');
        }
        const m = await c.query(
          `SELECT id FROM nightclub.memberships
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='ACTIVE'`,
          [g.tenantId, g.storeId, b.referrer_membership_id]);
        if (!m.rows[0]) throw E.invalid('referrer membership not found');
        const old = visit.referrer_membership_id as string | null;
        await c.query(
          `UPDATE nightclub.visits
              SET referrer_membership_id=$5, version=version+1,
                  updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [g.tenantId, g.storeId, eventId, visitId, b.referrer_membership_id]);
        // Re-point existing line attributions recorded under the old referrer.
        await c.query(
          `UPDATE nightclub.sales_attributions sa
              SET referrer_membership_id=$5, version=sa.version+1,
                  updated_at=CURRENT_TIMESTAMP
             FROM nightclub.sales_lines sl
             JOIN nightclub.sales_orders o
               ON o.tenant_id=sl.tenant_id AND o.store_id=sl.store_id
              AND o.event_id=sl.event_id AND o.id=sl.order_id
            WHERE sa.tenant_id=$1 AND sa.store_id=$2 AND sa.event_id=$3
              AND sa.sales_line_id=sl.id AND o.visit_id=$4
              AND sa.referrer_membership_id IS NOT DISTINCT FROM $6`,
          [g.tenantId, g.storeId, eventId, visitId,
           b.referrer_membership_id, old]);
        // Lines without any attribution gain one under the new referrer.
        // A visit has a single primary referrer -> 100% (basis_points is the
        // attribution share, not the reward rate; CHECK requires 1..10000).
        await c.query(
          `INSERT INTO nightclub.sales_attributions
             (tenant_id, store_id, event_id, sales_line_id,
              referrer_membership_id, basis_points, version)
           SELECT sl.tenant_id, sl.store_id, sl.event_id, sl.id, $4, 10000, 1
             FROM nightclub.sales_lines sl
             JOIN nightclub.sales_orders o
               ON o.tenant_id=sl.tenant_id AND o.store_id=sl.store_id
              AND o.event_id=sl.event_id AND o.id=sl.order_id
            WHERE sl.tenant_id=$1 AND sl.store_id=$2 AND sl.event_id=$3
              AND o.visit_id=$5
              AND NOT EXISTS (
                SELECT 1 FROM nightclub.sales_attributions sa
                 WHERE sa.tenant_id=sl.tenant_id AND sa.store_id=sl.store_id
                   AND sa.event_id=sl.event_id AND sa.sales_line_id=sl.id)`,
          [g.tenantId, g.storeId, eventId, b.referrer_membership_id, visitId]);
        const summary = await visitSummary(c, g, visitId, eventId);
        await emit(c, g, {
          eventId, eventType: 'visit.upserted', aggregateType: 'visit',
          aggregateId: visitId, aggregateVersion: visit.version + 1,
          payload: { visit: summary }, traceId: req.traceId,
        });
        await audit(c, g, {
          action: 'visit.attribution', targetType: 'visits', targetId: visitId,
          changes: {
            referrer_membership_id: { from: old, to: b.referrer_membership_id },
          },
          reason: b.reason ?? null, traceId: req.traceId,
        });
        return {
          httpStatus: 200,
          body: { visit: summary, trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- companion members on a visit (F-015) --------------------------------
  app.post('/stores/:storeId/events/:eventId/visits/:visitId/members', {
    schema: {
      params: eventChild('visitId'),
      body: body({
        display_name: str(200),
        customer_id: { type: ['string', 'null'], format: 'uuid' },
      }, ['display_name']),
    },
  }, async (req, reply) => {
    const { storeId, eventId, visitId } = req.params as { storeId: string; eventId: string; visitId: string };
    const caller = await visitCaller(req, storeId, eventId, 'visit.edit');
    const b = req.body as { display_name?: string; customer_id?: string | null };
    const g = caller.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: caller.operator?.sessionId ?? caller.member.membershipId,
      operation: 'visit.member.add', key: idemKey(req), body: { ...b, visitId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const v = await c.query(
          `SELECT id, status FROM nightclub.visits
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
            FOR UPDATE`, [g.tenantId, g.storeId, eventId, visitId]);
        if (!v.rows[0]) throw E.notFound('visit');
        if (v.rows[0].status !== 'ACTIVE') throw E.invalid('visit not active');
        if (b.customer_id) {
          const cu = await c.query(
            `SELECT id FROM nightclub.customers
              WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
            [g.tenantId, g.storeId, b.customer_id]);
          if (!cu.rows[0]) throw E.invalid('customer not found');
        }
        const ins = await c.query(
          `INSERT INTO nightclub.visit_members
             (tenant_id, store_id, event_id, visit_id, customer_id,
              display_name, member_kind)
           VALUES ($1,$2,$3,$4,$5,$6,'COMPANION') RETURNING id`,
          [g.tenantId, g.storeId, eventId, visitId,
           b.customer_id ?? null, b.display_name]);
        await audit(c, g, {
          action: 'visit.member.add', targetType: 'visit_members',
          targetId: ins.rows[0].id, changes: b, traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: { visit_member_id: ins.rows[0].id, trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  app.delete('/stores/:storeId/events/:eventId/visits/:visitId/members/:memberId', {
    schema: {
      params: params({
        storeId: sUuid, eventId: sUuid, visitId: sUuid, memberId: sUuid,
      }),
    },
  }, async (req, reply) => {
    const { storeId, eventId, visitId, memberId } = req.params as {
      storeId: string; eventId: string; visitId: string; memberId: string;
    };
    const caller = await visitCaller(req, storeId, eventId, 'visit.edit');
    const g = caller.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: caller.operator?.sessionId ?? caller.member.membershipId,
      operation: 'visit.member.remove', key: idemKey(req),
      body: { visitId, memberId }, receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const v = await c.query(
          `SELECT id, status FROM nightclub.visits
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
            FOR UPDATE`, [g.tenantId, g.storeId, eventId, visitId]);
        if (!v.rows[0]) throw E.notFound('visit');
        if (v.rows[0].status !== 'ACTIVE') throw E.invalid('visit not active');
        const del = await c.query(
          `DELETE FROM nightclub.visit_members
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3
              AND visit_id=$4 AND id=$5 AND member_kind='COMPANION'
            RETURNING id`,
          [g.tenantId, g.storeId, eventId, visitId, memberId]);
        if (!del.rows[0]) throw E.notFound('companion member');
        await audit(c, g, {
          action: 'visit.member.remove', targetType: 'visit_members',
          targetId: memberId, traceId: req.traceId,
        });
        return { httpStatus: 200, body: { removed: true, trace_id: req.traceId } };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- pass lookup for kiosk re-entry scanning (F-016) ----------------------
  // By QR token (hashed server-side) or by visit. Never exposes token_hash.
  app.get('/stores/:storeId/events/:eventId/passes', {
    schema: {
      params: eventParams,
      querystring: query({ token: str(200), visit_id: sUuid }),
    },
  }, async (req) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string };
    const caller = await visitCaller(req, storeId, eventId, 'entrance.checkin');
    const q = req.query as { token?: string; visit_id?: string };
    if (!q.token && !q.visit_id) throw E.invalid('token or visit_id required');
    return withCtx(caller.g, async (c) => {
      const r = await c.query(
        `SELECT p.id, p.visit_id, p.member_id, p.pass_kind, p.presence,
                p.expires_at, p.revoked_at IS NOT NULL AS revoked,
                vm.display_name AS member_name,
                v.reception_name AS visit_name
           FROM nightclub.entry_passes p
           LEFT JOIN nightclub.visit_members vm
             ON vm.tenant_id=p.tenant_id AND vm.store_id=p.store_id
            AND vm.event_id=p.event_id AND vm.id=p.member_id
           JOIN nightclub.visits v
             ON v.tenant_id=p.tenant_id AND v.store_id=p.store_id
            AND v.event_id=p.event_id AND v.id=p.visit_id
          WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.event_id=$3
            AND ($4::text IS NULL OR p.token_hash=$4)
            AND ($5::uuid IS NULL OR p.visit_id=$5)
          ORDER BY p.created_at DESC LIMIT 20`,
        [caller.g.tenantId, storeId, eventId,
         q.token ? sha256(q.token) : null, q.visit_id ?? null]);
      if (q.token && !r.rows[0]) throw E.notFound('pass');
      return { items: r.rows };
    });
  });

  // Exit / re-entry via group pass. Re-entry consumes no acquisition quota.
  const passMoveSchema = {
    schema: {
      params: eventParams,
      body: body({
        pass_id: sUuid,
        quantity: { type: 'integer', minimum: 1, maximum: 200 },
      }, ['pass_id']),
    },
  };
  app.post('/stores/:storeId/events/:eventId/passes/exit', passMoveSchema,
    async (req, reply) => {
      return passMove(req, reply, 'EXIT');
    });
  app.post('/stores/:storeId/events/:eventId/passes/reentry', passMoveSchema,
    async (req, reply) => {
      return passMove(req, reply, 'REENTRY');
    });

  async function passMove(req: FastifyRequest, reply: FastifyReply, kind: 'EXIT' | 'REENTRY') {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const caller = await visitCaller(
      req, storeId, eventId, kind === 'EXIT' ? 'entrance.checkout' : 'entrance.checkin');
    const b = req.body as { pass_id?: string; quantity?: number };
    if (!b?.pass_id) throw E.invalid('pass_id required');
    const qty = b.quantity ?? 1;
    const g = caller.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: caller.operator?.sessionId ?? caller.member.membershipId,
      operation: `pass.${kind.toLowerCase()}`, key: idemKey(req), body: { ...b, kind },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const p = await c.query(
          `SELECT * FROM nightclub.entry_passes
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
            FOR UPDATE`, [g.tenantId, g.storeId, eventId, b.pass_id]);
        const pass = p.rows[0];
        if (!pass || pass.revoked_at) throw E.notFound('pass');
        if (new Date(pass.expires_at) <= new Date()) throw E.invalid('pass expired');
        if (kind === 'EXIT' && pass.presence !== 'INSIDE') throw E.invalid('not inside');
        if (kind === 'REENTRY' && pass.presence !== 'OUTSIDE') throw E.invalid('not outside');
        await c.query(
          `UPDATE nightclub.entry_passes SET presence=$5, version=version+1,
              updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [g.tenantId, g.storeId, eventId, pass.id,
           kind === 'EXIT' ? 'OUTSIDE' : 'INSIDE']);
        const en = await c.query(
          `INSERT INTO nightclub.admission_events
             (tenant_id, store_id, event_id, visit_id, segment_id, pass_id,
              operator_session_id, actor_membership_id, kind, quantity,
              present_delta, first_entry_delta, operation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12) RETURNING id`,
          [g.tenantId, g.storeId, eventId, pass.visit_id,
           // segment: reuse the visit's latest authorized segment for ledger linkage
           (await c.query(
             `SELECT id FROM nightclub.admission_segments
               WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND visit_id=$4
                 AND status='AUTHORIZED' ORDER BY created_at DESC LIMIT 1`,
             [g.tenantId, g.storeId, eventId, pass.visit_id])).rows[0]?.id ?? null,
           pass.id, caller.operator?.sessionId ?? null,
           caller.member.membershipId, kind, qty,
           kind === 'EXIT' ? -qty : qty, uuid()]);
        const summary = await visitSummary(c, g, pass.visit_id, eventId);
        await emit(c, g, {
          eventId, eventType: `pass.${kind.toLowerCase()}`, aggregateType: 'visit',
          aggregateId: pass.visit_id, aggregateVersion: 1,
          payload: { visit: summary, pass_id: pass.id }, traceId: req.traceId,
        });
        return {
          httpStatus: 200,
          body: { entry_ids: [en.rows[0].id], visit: summary, trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  }

  // Entry correction: append-only compensating entry (manager only).
  app.post('/stores/:storeId/events/:eventId/entries/:entryId/corrections', {
    schema: {
      params: eventChild('entryId'),
      body: body({ reason: str(1000) }, ['reason']),
    },
  }, async (req, reply) => {
    const { storeId, eventId, entryId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const caller = await visitCaller(req, storeId, eventId, 'entry.correct');
    const b = req.body as { reason?: string };
    if (!b?.reason) throw E.invalid('reason required');
    const g = caller.g;
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: caller.operator?.sessionId ?? caller.member.membershipId,
      operation: 'entry.correct', key: idemKey(req), body: { ...b, entryId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const en = await c.query(
          `SELECT * FROM nightclub.admission_events
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [g.tenantId, g.storeId, eventId, entryId]);
        const orig = en.rows[0];
        if (!orig) throw E.notFound('entry');
        if (orig.kind !== 'FIRST_ENTRY') throw E.invalid('only first entries can be corrected');
        const already = await c.query(
          `SELECT id FROM nightclub.admission_events
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND corrects_id=$4`,
          [g.tenantId, g.storeId, eventId, entryId]);
        if (already.rows[0]) throw E.invalid('already corrected');
        const corr = await c.query(
          `INSERT INTO nightclub.admission_events
             (tenant_id, store_id, event_id, visit_id, segment_id, pass_id,
              operator_session_id, actor_membership_id, kind, quantity,
              present_delta, first_entry_delta, corrects_id, operation_id, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CORRECTION',$9,$10,$11,$12,$13,$14)
           RETURNING id`,
          [g.tenantId, g.storeId, eventId, orig.visit_id, orig.segment_id,
           orig.pass_id, caller.operator?.sessionId ?? null,
           caller.member.membershipId, orig.quantity,
           -orig.present_delta, -orig.first_entry_delta, entryId, uuid(), b.reason]);
        // give the consumed quota back to held (the entry never happened)
        await c.query(
          `UPDATE nightclub.admission_segments
              SET first_entered_count = first_entered_count - $5,
                  version = version + 1, updated_at = CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [g.tenantId, g.storeId, eventId, orig.segment_id, orig.quantity]);
        await c.query(
          `UPDATE nightclub.quota_allocations
              SET consumed_count = consumed_count - $5,
                  held_count = held_count + $5,
                  version = version + 1, updated_at = CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND segment_id=$4`,
          [g.tenantId, g.storeId, eventId, orig.segment_id, orig.quantity]);
        await c.query(
          `UPDATE nightclub.quota_buckets b
              SET consumed_count = consumed_count - $5,
                  held_count = held_count + $5,
                  version = version + 1, updated_at = CURRENT_TIMESTAMP
            WHERE b.tenant_id=$1 AND b.store_id=$2 AND b.event_id=$3
              AND b.id IN (SELECT bucket_id FROM nightclub.quota_allocations
                            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3
                              AND segment_id=$4)`,
          [g.tenantId, g.storeId, eventId, orig.segment_id, orig.quantity]);
        const summary = await visitSummary(c, g, orig.visit_id, eventId);
        await emit(c, g, {
          eventId, eventType: 'entry.corrected', aggregateType: 'visit',
          aggregateId: orig.visit_id, aggregateVersion: 1,
          payload: { visit: summary, corrects: entryId }, traceId: req.traceId,
        });
        await audit(c, g, {
          action: 'entry.correct', targetType: 'admission_events',
          targetId: entryId, reason: b.reason ?? null, traceId: req.traceId,
        });
        return {
          httpStatus: 200,
          body: { correction_id: corr.rows[0].id, visit: summary, trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });
}

// ---------- shared internals ----------
function memberIsStaff(m: MemberCtx) {
  // staff = has permissions beyond the referrer self-service set
  return [...m.permissions].some((p) =>
    !['visit.create', 'visit.read', 'visit.edit', 'visit.cancel', 'report.own',
      'reward.dispute', 'session.end', 'session.lock', 'session.read',
      'sync.read', 'event.read', 'customer.lookup'].includes(p));
}

interface JudgeArgs {
  eventId: string; visitId: string;
  rule: Policy['settings']['price_rules'][number];
  count: number; requiredCustomer: string | null; visitCustomer: string | null;
  actorMembership: string; referrerId: string | null; isProxy: boolean;
  policy: Policy['settings']; approvalReason: string | null; currency: string;
}
interface JudgeResult {
  status: 'AUTHORIZED' | 'PENDING';
  method: 'STANDARD' | 'TRUSTED_ACTOR' | 'CUSTOMER_PERMIT' | null;
  permitId: string | null; priceRuleId: string | null;
  buckets: { key: string; kind: string; limitMode: 'LIMITED' | 'UNLIMITED'; limit: number | null }[];
  snapshot: Record<string, unknown>;
}
async function judgeSegment(c: Client, g: Guc, a: JudgeArgs): Promise<JudgeResult> {
  const pr = await c.query(
    `SELECT id FROM nightclub.price_rules
      WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3
        AND rule_key=$4 AND policy_version_id = (
          SELECT id FROM nightclub.policy_versions
           WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND status='PUBLISHED'
           ORDER BY version DESC LIMIT 1)`,
    [g.tenantId, g.storeId, a.eventId, a.rule.rule_key]);
  const priceRuleId = pr.rows[0]?.id ?? null;
  const snap = { rule_key: a.rule.rule_key, kind: a.rule.kind };
  const freeBucket = a.rule.amount_minor === 0
    ? [{ key: 'event_free', kind: 'EVENT_HARD', limitMode: 'LIMITED' as const, limit: null }]
    : [];

  // 3) STANDARD: rule open to general admission.
  if (a.rule.standard_allowed && !a.requiredCustomer) {
    return {
      status: 'AUTHORIZED', method: 'STANDARD', permitId: null, priceRuleId,
      buckets: freeBucket, snapshot: snap,
    };
  }
  // 4) TRUSTED_ACTOR: registering member holds a valid actor permit.
  const actorPermits = await findPermits(c, g, 'ACTOR', a.actorMembership);
  for (const p of actorPermits) {
    const m = permitMatches(p, {
      eventId: a.eventId, ruleKey: a.rule.rule_key, count: a.count,
      isProxy: a.isProxy, referrerId: a.referrerId,
    });
    if (m.ok) {
      const el = p.conditions.event_limit;
      return {
        status: 'AUTHORIZED', method: 'TRUSTED_ACTOR', permitId: p.id, priceRuleId,
        buckets: [
          { key: `actor:${a.actorMembership}`, kind: 'ACTOR_BYPASS',
            limitMode: el.mode === 'UNLIMITED' ? 'UNLIMITED' : 'LIMITED',
            limit: el.mode === 'LIMITED' ? el.value : 0 },
          ...freeBucket,
        ],
        snapshot: { ...snap, permit_key: p.permit_key },
      };
    }
  }
  // 5) CUSTOMER_PERMIT: the visiting customer holds a permit.
  const custId = a.requiredCustomer ?? a.visitCustomer;
  if (custId) {
    const custPermits = await findPermits(c, g, 'CUSTOMER', custId);
    for (const p of custPermits) {
      const m = permitMatches(p, {
        eventId: a.eventId, ruleKey: a.rule.rule_key, count: a.count,
        isProxy: a.isProxy, referrerId: a.referrerId,
      });
      if (m.ok) {
        const el = p.conditions.event_limit;
        return {
          status: 'AUTHORIZED', method: 'CUSTOMER_PERMIT', permitId: p.id, priceRuleId,
          buckets: [
            { key: `customer:${custId}`, kind: 'CUSTOMER',
              limitMode: el.mode === 'UNLIMITED' ? 'UNLIMITED' : 'LIMITED',
              limit: el.mode === 'LIMITED' ? el.value : 0 },
            ...freeBucket,
          ],
          snapshot: {
            ...snap, permit_key: p.permit_key,
            requires_identity_check: !!p.conditions.principal_presence_required,
          },
        };
      }
    }
  }
  // 6) MANUAL: request approval (designated + entrance both decide).
  return {
    status: 'PENDING', method: null, permitId: null, priceRuleId,
    buckets: [], snapshot: snap,
  };
}

async function releaseHold(c: Client, g: Guc, eventId: string, segmentId: string, count: number) {
  const allocs = await c.query(
    `SELECT id, bucket_id, held_count FROM nightclub.quota_allocations
      WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND segment_id=$4
      FOR UPDATE`, [g.tenantId, g.storeId, eventId, segmentId]);
  let left = count;
  for (const a of allocs.rows) {
    const take = Math.min(a.held_count, left);
    if (take <= 0) continue;
    await c.query(
      `UPDATE nightclub.quota_allocations SET held_count=held_count-$5,
          version=version+1, updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
      [g.tenantId, g.storeId, eventId, a.id, take]);
    await c.query(
      `UPDATE nightclub.quota_buckets SET held_count=held_count-$4,
          version=version+1, updated_at=CURRENT_TIMESTAMP
        WHERE id=$1 AND tenant_id=$2 AND store_id=$3`,
      [a.bucket_id, g.tenantId, g.storeId, take]);
    left -= take;
  }
}

async function consumeHold(c: Client, g: Guc, eventId: string, segmentId: string, count: number) {
  const allocs = await c.query(
    `SELECT id, bucket_id, held_count FROM nightclub.quota_allocations
      WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND segment_id=$4
      FOR UPDATE`, [g.tenantId, g.storeId, eventId, segmentId]);
  let left = count;
  for (const a of allocs.rows) {
    const take = Math.min(a.held_count, left);
    if (take <= 0) continue;
    await c.query(
      `UPDATE nightclub.quota_allocations
          SET held_count=held_count-$5, consumed_count=consumed_count+$5,
              version=version+1, updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
      [g.tenantId, g.storeId, eventId, a.id, take]);
    await c.query(
      `UPDATE nightclub.quota_buckets
          SET held_count=held_count-$4, consumed_count=consumed_count+$4,
              version=version+1, updated_at=CURRENT_TIMESTAMP
        WHERE id=$1 AND tenant_id=$2 AND store_id=$3`,
      [a.bucket_id, g.tenantId, g.storeId, take]);
    left -= take;
  }
}

async function recordAdmissionSale(c: Client, g: Guc, a: {
  eventId: string; visitId: string; segmentId: string; count: number;
  unit: number; currency: string; operationId: string;
}) {
  // The caller holds the visit row lock, so check-then-insert is race-free.
  const ex = await c.query(
    `SELECT id FROM nightclub.sales_orders
      WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3
        AND visit_id=$4 AND kind='ADMISSION'`,
    [g.tenantId, g.storeId, a.eventId, a.visitId]);
  let orderId = ex.rows[0]?.id as string | undefined;
  if (!orderId) {
    const ord = await c.query(
      `INSERT INTO nightclub.sales_orders
         (tenant_id, store_id, event_id, kind, visit_id, currency, status)
       VALUES ($1,$2,$3,'ADMISSION',$4,$5,'FINALIZED') RETURNING id`,
      [g.tenantId, g.storeId, a.eventId, a.visitId, a.currency]);
    orderId = ord.rows[0].id;
  }
  const line = await c.query(
    `INSERT INTO nightclub.sales_lines
       (tenant_id, store_id, event_id, order_id, segment_id, category,
        line_kind, description, quantity, gross_minor, tax_minor, currency,
        source_key)
     VALUES ($1,$2,$3,$4,$5,'ADMISSION','SALE','admission',$6,$7,0,$8,$9)
     RETURNING id`,
    [g.tenantId, g.storeId, a.eventId, orderId, a.segmentId,
     a.count, a.unit * a.count, a.currency, `entry:${a.operationId}:${a.segmentId}`]);
  // Referrer attribution for settlement/rewards.
  const v = await c.query(
    `SELECT referrer_membership_id FROM nightclub.visits
      WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
    [g.tenantId, g.storeId, a.eventId, a.visitId]);
  const referrer = v.rows[0]?.referrer_membership_id as string | null;
  if (referrer) {
    const rr = await c.query(
      `SELECT id, conditions FROM nightclub.reward_rules
        WHERE tenant_id=$1 AND store_id=$2
          AND (referrer_membership_id=$3 OR referrer_membership_id IS NULL)
          AND valid_from <= CURRENT_TIMESTAMP AND valid_to > CURRENT_TIMESTAMP
        ORDER BY referrer_membership_id NULLS LAST LIMIT 1`,
      [g.tenantId, g.storeId, referrer]);
    // A visit's primary referrer carries the full share when no reward rule
    // narrows it (CHECK requires basis_points 1..10000).
    const bp = rr.rows[0]
      ? (rr.rows[0].conditions as { basis_points?: number }).basis_points ?? 10000
      : 10000;
    await c.query(
      `INSERT INTO nightclub.sales_attributions
         (tenant_id, store_id, event_id, sales_line_id, referrer_membership_id,
          basis_points, version)
       VALUES ($1,$2,$3,$4,$5,$6,1)`,
      [g.tenantId, g.storeId, a.eventId, line.rows[0].id, referrer, bp]);
  }
}
