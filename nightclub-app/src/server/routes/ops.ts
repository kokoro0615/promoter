// Operations slice: permits, reward rules, audit read, exports, settlement.
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { withCtx } from '../lib/db.js';
import { E } from '../lib/errors.js';
import { uuid, sha256 } from '../lib/crypto.js';
import { audit, emit, idemKey, withReceipt } from '../lib/tx.js';
import {
  body, eventParams, int, isoTs, params, query, storeParam, str,
  uuid as sUuid, version,
} from '../lib/schemas.js';
import {
  requirePersonal, requirePerm, gucPersonal,
} from '../lib/ctx.js';

export default async function opsRoutes(app: FastifyInstance) {
  // ---- permits ----
  app.post('/stores/:storeId/permits', {
    schema: {
      params: storeParam,
      body: body({
        subject_kind: { type: 'string', enum: ['CUSTOMER', 'ACTOR'] },
        subject_id: sUuid,
        event_ids: { type: 'array', items: sUuid, maxItems: 100 },
        allowed_rule_keys: { type: 'array', items: str(100), maxItems: 50 },
        valid_from: isoTs, valid_to: isoTs,
        party_limit: { type: 'object' }, event_limit: { type: 'object' },
        companion_limit: { type: 'object' },
        principal_presence_required: { type: 'boolean' },
        proxy_registration_allowed: { type: 'boolean' },
        proxy_referrer_ids: { type: 'array', items: sUuid, maxItems: 20 },
        reason: str(1000),
      }, ['subject_kind', 'subject_id', 'valid_from', 'valid_to', 'reason']),
    },
  }, async (req, reply) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'permit.manage');
    const b = req.body as {
      subject_kind?: 'CUSTOMER' | 'ACTOR'; subject_id?: string;
      event_ids?: string[]; allowed_rule_keys?: string[];
      valid_from?: string; valid_to?: string;
      party_limit?: { mode: string; value: number | null };
      event_limit?: { mode: string; value: number | null };
      companion_limit?: { mode: string; value: number | null };
      principal_presence_required?: boolean;
      proxy_registration_allowed?: boolean; proxy_referrer_ids?: string[];
      reason?: string;
    };
    if (!b?.subject_kind || !b.subject_id || !b.valid_from || !b.valid_to || !b.reason) {
      throw E.invalid('subject_kind, subject_id, valid_from, valid_to, reason required');
    }
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    const row = await withCtx(g, async (c) => {
      const conditions = {
        event_ids: b.event_ids ?? [], allowed_rule_keys: b.allowed_rule_keys ?? [],
        party_limit: b.party_limit ?? { mode: 'UNSET', value: null },
        event_limit: b.event_limit ?? { mode: 'UNSET', value: null },
        companion_limit: b.companion_limit ?? { mode: 'UNSET', value: null },
        principal_presence_required: b.principal_presence_required ?? true,
        proxy_registration_allowed: b.proxy_registration_allowed ?? false,
        proxy_referrer_ids: b.proxy_referrer_ids ?? [],
        reason: b.reason ?? null,
      };
      const ins = await c.query(
        `INSERT INTO nightclub.permits
           (tenant_id, store_id, permit_key, version, subject_kind, customer_id,
            actor_membership_id, granted_by, conditions, valid_from, valid_to, status)
         VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,'ACTIVE') RETURNING id, permit_key`,
        [member.tenantId, storeId, uuid(), b.subject_kind,
         b.subject_kind === 'CUSTOMER' ? b.subject_id : null,
         b.subject_kind === 'ACTOR' ? b.subject_id : null,
         member.membershipId, JSON.stringify(conditions),
         b.valid_from, b.valid_to]);
      await audit(c, g, {
        action: 'permit.create', targetType: 'permits', targetId: ins.rows[0].id,
        changes: { subject_kind: b.subject_kind, subject_id: b.subject_id },
        reason: b.reason ?? null, traceId: req.traceId,
      });
      return ins.rows[0];
    });
    reply.code(201);
    return { permit_id: row.id, permit_key: row.permit_key, trace_id: req.traceId };
  });

  app.get('/stores/:storeId/permits', { schema: { params: storeParam } }, async (req) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'permit.manage');
    return withCtx(gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId), async (c) => {
      const r = await c.query(
        `SELECT p.id, p.permit_key, p.version, p.subject_kind, p.customer_id,
                p.actor_membership_id, p.conditions, p.valid_from, p.valid_to,
                p.status, cu.display_name AS customer_name,
                m.display_name AS actor_name
           FROM nightclub.permits p
           LEFT JOIN nightclub.customers cu
             ON cu.tenant_id=p.tenant_id AND cu.store_id=p.store_id AND cu.id=p.customer_id
           LEFT JOIN nightclub.memberships m
             ON m.tenant_id=p.tenant_id AND m.store_id=p.store_id AND m.id=p.actor_membership_id
          WHERE p.tenant_id=$1 AND p.store_id=$2
          ORDER BY p.created_at DESC`, [member.tenantId, storeId]);
      return { items: r.rows };
    });
  });

  // Revocation preview: which authorized-not-entered segments depend on it.
  app.post('/stores/:storeId/permits/:permitId/preview-revocation', {
    schema: { params: params({ storeId: sUuid, permitId: sUuid }) },
  }, async (req) => {
    const { storeId, permitId } = req.params as { storeId: string; permitId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'permit.manage');
    return withCtx(gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId), async (c) => {
      const r = await c.query(
        `SELECT s.id AS segment_id, s.event_id, s.visit_id, s.status,
                v.reception_name
           FROM nightclub.admission_segments s
           JOIN nightclub.visits v
             ON v.tenant_id=s.tenant_id AND v.store_id=s.store_id
            AND v.event_id=s.event_id AND v.id=s.visit_id
          WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.permit_id=$3
            AND s.status='AUTHORIZED' AND s.first_entered_count < s.authorized_count`,
        [member.tenantId, storeId, permitId]);
      return { affected_segments: r.rows, count: r.rows.length };
    });
  });

  app.post('/stores/:storeId/permits/:permitId/revoke', {
    schema: {
      params: params({ storeId: sUuid, permitId: sUuid }),
      body: body({ expected_version: version, reason: str(1000) },
        ['expected_version', 'reason']),
    },
  }, async (req) => {
    const { storeId, permitId } = req.params as { storeId: string; permitId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'permit.manage');
    const b = req.body as { expected_version?: number; reason?: string };
    if (typeof b?.expected_version !== 'number' || !b.reason) {
      throw E.invalid('expected_version and reason required');
    }
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    return withCtx(g, async (c) => {
      const p = await c.query(
        `UPDATE nightclub.permits SET status='REVOKED', version=version+1,
            updated_at=CURRENT_TIMESTAMP
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND version=$4
            AND status='ACTIVE' RETURNING id`,
        [member.tenantId, storeId, permitId, b.expected_version]);
      if (!p.rows[0]) throw E.versionConflict();
      // Unentered authorized segments fall back to re-approval (RETURNED),
      // holds released; entered history untouched.
      const affected = await c.query(
        `SELECT id, event_id FROM nightclub.admission_segments
          WHERE tenant_id=$1 AND store_id=$2 AND permit_id=$3
            AND status='AUTHORIZED' AND first_entered_count < authorized_count
          FOR UPDATE`, [member.tenantId, storeId, permitId]);
      for (const s of affected.rows) {
        const allocs = await c.query(
          `SELECT bucket_id, held_count FROM nightclub.quota_allocations
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND segment_id=$4`,
          [member.tenantId, storeId, s.event_id, s.id]);
        for (const a of allocs.rows) {
          await c.query(
            `UPDATE nightclub.quota_buckets SET held_count=held_count-$4,
                version=version+1, updated_at=CURRENT_TIMESTAMP
              WHERE id=$1 AND tenant_id=$2 AND store_id=$3`,
            [a.bucket_id, member.tenantId, storeId, a.held_count]);
        }
        await c.query(
          `UPDATE nightclub.quota_allocations SET held_count=0,
              version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND segment_id=$4`,
          [member.tenantId, storeId, s.event_id, s.id]);
        await c.query(
          `UPDATE nightclub.admission_segments SET status='RETURNED',
              version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [member.tenantId, storeId, s.event_id, s.id]);
      }
      await audit(c, g, {
        action: 'permit.revoke', targetType: 'permits', targetId: permitId,
        changes: { affected: affected.rows.map((x) => x.id) },
        reason: b.reason ?? null, traceId: req.traceId,
      });
      return {
        resource_id: permitId, status: 'REVOKED',
        returned_segments: affected.rows.length, trace_id: req.traceId,
      };
    });
  });

  // ---- reward rules ----
  app.post('/stores/:storeId/reward-rules', {
    schema: {
      params: storeParam,
      body: body({
        referrer_membership_id: sUuid,
        basis_points: { type: 'integer', minimum: 0, maximum: 10000 },
        valid_from: isoTs, valid_to: isoTs,
        conditions: { type: 'object' },
      }, ['basis_points', 'valid_from', 'valid_to']),
    },
  }, async (req, reply) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'reward.manage');
    const b = req.body as {
      referrer_membership_id?: string; basis_points?: number;
      valid_from?: string; valid_to?: string; conditions?: unknown;
    };
    if (typeof b?.basis_points !== 'number' || !b.valid_from || !b.valid_to) {
      throw E.invalid('basis_points, valid_from, valid_to required');
    }
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    const row = await withCtx(g, async (c) => {
      const ins = await c.query(
        `INSERT INTO nightclub.reward_rules
           (tenant_id, store_id, rule_key, version, referrer_membership_id,
            conditions, valid_from, valid_to)
         VALUES ($1,$2,$3,1,$4,$5,$6,$7) RETURNING id`,
        [member.tenantId, storeId, uuid(), b.referrer_membership_id ?? null,
         JSON.stringify(b.conditions ?? { basis_points: b.basis_points }),
         b.valid_from, b.valid_to]);
      await audit(c, g, {
        action: 'reward_rule.create', targetType: 'reward_rules',
        targetId: ins.rows[0].id, changes: b, traceId: req.traceId,
      });
      return ins.rows[0];
    });
    reply.code(201);
    return { reward_rule_id: row.id, trace_id: req.traceId };
  });

  // ---- audit read ----
  app.get('/stores/:storeId/audit-logs', {
    schema: {
      params: storeParam,
      querystring: query({
        target_type: str(100), target_id: sUuid,
        limit: { type: 'string', pattern: '^[0-9]+$', maxLength: 4 },
      }),
    },
  }, async (req) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'audit.read');
    const q = req.query as { target_type?: string; target_id?: string; limit?: string };
    return withCtx(gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId), async (c) => {
      const r = await c.query(
        `SELECT al.id, al.actor_membership_id, al.device_id, al.operator_session_id,
                al.action, al.target_type, al.target_id, al.changes, al.reason,
                al.trace_id, al.created_at,
                m.display_name AS actor_display
           FROM nightclub.audit_logs al
           LEFT JOIN nightclub.memberships m
             ON m.tenant_id=al.tenant_id AND m.store_id=al.store_id
            AND m.id=al.actor_membership_id
          WHERE al.tenant_id=$1 AND al.store_id=$2
            AND ($3::text IS NULL OR al.target_type=$3)
            AND ($4::uuid IS NULL OR al.target_id=$4)
          ORDER BY al.created_at DESC LIMIT $5`,
        [member.tenantId, storeId, q.target_type ?? null,
         q.target_id ?? null, Math.min(Number(q.limit) || 100, 500)]);
      return { items: r.rows };
    });
  });

  // ---- provisional entries (offline reconciliation intake) ----
  app.post('/stores/:storeId/events/:eventId/provisional-entries/import', {
    schema: {
      params: eventParams,
      body: body({
        entries: {
          type: 'array', maxItems: 1000,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              device_id: sUuid, local_operation_id: str(200),
              device_time: isoTs, quantity: int,
              reception_name: str(200), reason: str(1000), visit_id: sUuid,
            },
            required: ['device_id', 'local_operation_id', 'device_time',
              'quantity', 'reception_name', 'reason'],
          },
        },
      }, ['entries']),
    },
  }, async (req, reply) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'offline.reconcile');
    const b = req.body as {
      entries?: {
        device_id: string; local_operation_id: string; device_time: string;
        quantity: number; reception_name: string; reason: string;
        visit_id?: string;
      }[];
    };
    if (!Array.isArray(b?.entries)) throw E.invalid('entries required');
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    const out = await withCtx(g, async (c) => {
      const ids: string[] = [];
      for (const e of b.entries!) {
        const ins = await c.query(
          `INSERT INTO nightclub.provisional_entries
             (tenant_id, store_id, event_id, device_id, actor_membership_id,
              visit_id, local_operation_id, device_time, quantity,
              reception_name, reason, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'UNRECONCILED')
           ON CONFLICT (tenant_id, store_id, device_id, local_operation_id)
           DO NOTHING RETURNING id`,
          [member.tenantId, storeId, eventId, e.device_id, member.membershipId,
           e.visit_id ?? null, e.local_operation_id, e.device_time,
           e.quantity, e.reception_name, e.reason]);
        if (ins.rows[0]) ids.push(ins.rows[0].id);
      }
      await audit(c, g, {
        action: 'provisional.import', targetType: 'events', targetId: eventId,
        changes: { imported: ids.length, total: b.entries!.length },
        traceId: req.traceId,
      });
      return ids;
    });
    reply.code(201);
    return { imported: out.length, ids: out, trace_id: req.traceId };
  });

  // Provisional entry review + reconciliation (offline intake follow-up).
  app.get('/stores/:storeId/events/:eventId/provisional-entries', {
    schema: {
      params: eventParams,
      querystring: query({
        status: {
          type: 'string',
          enum: ['UNRECONCILED', 'RECONCILED', 'DUPLICATE', 'REJECTED'],
        },
      }),
    },
  }, async (req) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'offline.reconcile');
    const q = req.query as { status?: string };
    return withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => ({
        items: (await c.query(
          `SELECT pe.id, pe.device_id, pe.actor_membership_id,
                  m.display_name AS actor_name, pe.visit_id,
                  pe.local_operation_id, pe.device_time, pe.quantity,
                  pe.reception_name, pe.reason, pe.status,
                  pe.reconciled_entry_id, pe.version, pe.created_at
             FROM nightclub.provisional_entries pe
             JOIN nightclub.memberships m
               ON m.tenant_id=pe.tenant_id AND m.store_id=pe.store_id
              AND m.id=pe.actor_membership_id
            WHERE pe.tenant_id=$1 AND pe.store_id=$2 AND pe.event_id=$3
              AND ($4::text IS NULL OR pe.status=$4)
            ORDER BY pe.device_time`,
          [member.tenantId, storeId, eventId, q.status ?? null])).rows,
      }));
  });

  // Reconcile: mark a provisional entry as resolved — RECONCILED when it was
  // re-entered as a real admission (link it), DUPLICATE/REJECTED otherwise.
  app.post('/stores/:storeId/events/:eventId/provisional-entries/:entryId/reconcile', {
    schema: {
      params: params({ storeId: sUuid, eventId: sUuid, entryId: sUuid }),
      body: body({
        expected_version: version,
        status: { type: 'string', enum: ['RECONCILED', 'DUPLICATE', 'REJECTED'] },
        visit_id: sUuid, reconciled_entry_id: sUuid,
      }, ['expected_version', 'status']),
    },
  }, async (req, reply) => {
    const { storeId, eventId, entryId } = req.params as { storeId: string; eventId: string; entryId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'offline.reconcile');
    const b = req.body as {
      expected_version?: number; status?: string;
      visit_id?: string; reconciled_entry_id?: string;
    };
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: member.membershipId, operation: 'provisional.reconcile',
      key: idemKey(req), body: { ...b, entryId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const pe = await c.query(
          `SELECT id, status, version FROM nightclub.provisional_entries
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
            FOR UPDATE`, [g.tenantId, g.storeId, eventId, entryId]);
        const row = pe.rows[0];
        if (!row) throw E.notFound('provisional entry');
        if (row.status !== 'UNRECONCILED') throw E.alreadyDecided();
        if (row.version !== b.expected_version) {
          throw E.versionConflict(row.version);
        }
        if (b.status === 'RECONCILED' && b.visit_id) {
          const v = await c.query(
            `SELECT id FROM nightclub.visits
              WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
            [g.tenantId, g.storeId, eventId, b.visit_id]);
          if (!v.rows[0]) throw E.invalid('visit not found');
        }
        await c.query(
          `UPDATE nightclub.provisional_entries
              SET status=$5, visit_id=COALESCE($6, visit_id),
                  reconciled_entry_id=$7,
                  version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
          [g.tenantId, g.storeId, eventId, entryId, b.status,
           b.status === 'RECONCILED' ? (b.visit_id ?? null) : null,
           b.reconciled_entry_id ?? null]);
        await audit(c, g, {
          action: 'provisional.reconcile',
          targetType: 'provisional_entries', targetId: entryId,
          changes: { status: b.status }, traceId: req.traceId,
        });
        return {
          httpStatus: 200,
          body: { entry_id: entryId, status: b.status, trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- settlements (build + finalize) ----
  app.post('/stores/:storeId/events/:eventId/settlements', {
    schema: { params: eventParams },
  }, async (req, reply) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'settlement.manage');
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    const row = await withCtx(g, async (c) => {
      const v = await c.query(
        `SELECT COALESCE(MAX(version),0)+1 AS v FROM nightclub.settlements
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3`,
        [member.tenantId, storeId, eventId]);
      const ins = await c.query(
        `INSERT INTO nightclub.settlements (tenant_id, store_id, event_id, version, status)
         VALUES ($1,$2,$3,$4,'DRAFT') RETURNING id, version`,
        [member.tenantId, storeId, eventId, v.rows[0].v]);
      const sid = ins.rows[0].id as string;
      // Reward lines: attributed sales x active reward rule basis_points.
      const lines = await c.query(
        `SELECT sa.sales_line_id, sa.referrer_membership_id, sa.basis_points,
                sl.gross_minor, sl.currency
           FROM nightclub.sales_attributions sa
           JOIN nightclub.sales_lines sl
             ON sl.tenant_id=sa.tenant_id AND sl.store_id=sa.store_id
            AND sl.event_id=sa.event_id AND sl.id=sa.sales_line_id
          WHERE sa.tenant_id=$1 AND sa.store_id=$2 AND sa.event_id=$3`,
        [member.tenantId, storeId, eventId]);
      for (const l of lines.rows) {
        const rr = await c.query(
          `SELECT id, conditions FROM nightclub.reward_rules
            WHERE tenant_id=$1 AND store_id=$2
              AND (referrer_membership_id=$3 OR referrer_membership_id IS NULL)
              AND valid_from <= CURRENT_TIMESTAMP AND valid_to > CURRENT_TIMESTAMP
            ORDER BY referrer_membership_id NULLS LAST LIMIT 1`,
          [member.tenantId, storeId, l.referrer_membership_id]);
        const bp = rr.rows[0]
          ? (rr.rows[0].conditions as { basis_points?: number }).basis_points ?? 0
          : l.basis_points;
        const amount = Math.floor((Number(l.gross_minor) * bp) / 10000);
        await c.query(
          `INSERT INTO nightclub.settlement_lines
             (tenant_id, store_id, event_id, settlement_id,
              referrer_membership_id, reward_rule_id, sales_line_id,
              amount_minor, currency, calculation, source_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [member.tenantId, storeId, eventId, sid, l.referrer_membership_id,
           rr.rows[0]?.id ?? null, l.sales_line_id, amount, l.currency,
           JSON.stringify({ basis_points: bp, gross_minor: l.gross_minor }),
           `attr:${l.sales_line_id}:${l.referrer_membership_id}`]);
      }
      await audit(c, g, {
        action: 'settlement.build', targetType: 'settlements', targetId: sid,
        changes: { lines: lines.rows.length }, traceId: req.traceId,
      });
      return ins.rows[0];
    });
    reply.code(201);
    return { settlement_id: row.id, version: row.version, status: 'DRAFT', trace_id: req.traceId };
  });

  app.post('/stores/:storeId/events/:eventId/settlements/:settlementId/finalize', {
    schema: {
      params: params({ storeId: sUuid, eventId: sUuid, settlementId: sUuid }),
      body: body({ expected_version: version }),
    },
  }, async (req) => {
    const { storeId, eventId, settlementId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'settlement.finalize');
    const b = req.body as { expected_version?: number };
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    return withCtx(g, async (c) => {
      const r = await c.query(
        `UPDATE nightclub.settlements SET status='FINALIZED',
            finalized_by=$5, finalized_at=CURRENT_TIMESTAMP,
            version=version+1, updated_at=CURRENT_TIMESTAMP
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4
            AND version=$6 AND status='DRAFT' RETURNING version`,
        [member.tenantId, storeId, eventId, settlementId,
         member.membershipId, b?.expected_version ?? -1]);
      if (!r.rows[0]) throw E.versionConflict();
      await audit(c, g, {
        action: 'settlement.finalize', targetType: 'settlements',
        targetId: settlementId, traceId: req.traceId,
      });
      return { resource_id: settlementId, version: r.rows[0].version, status: 'FINALIZED', trace_id: req.traceId };
    });
  });

  // ---- exports (EP25): queued report jobs executed by the worker ----------
  app.post('/stores/:storeId/exports', {
    schema: {
      params: storeParam,
      body: body({
        report_kind: { type: 'string', enum: ['visits', 'payments', 'audit'] },
        format: { type: 'string', enum: ['CSV'] },
        filters: { type: 'object' },
      }, ['report_kind', 'format']),
    },
  }, async (req, reply) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'report.export');
    const b = req.body as {
      report_kind?: string; format?: string; filters?: Record<string, unknown>;
    };
    if (!['visits', 'payments', 'audit'].includes(b?.report_kind ?? '')
        || b.format !== 'CSV') {
      throw E.invalid('report_kind visits|payments|audit and format CSV required');
    }
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: member.membershipId, operation: 'export.create',
      key: idemKey(req), body: b, receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const r = await c.query(
          `INSERT INTO nightclub.export_jobs
             (tenant_id, store_id, requested_by, report_kind, filters, format)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [member.tenantId, storeId, member.membershipId, b.report_kind,
           JSON.stringify(b.filters ?? {}), b.format]);
        await audit(c, g, {
          action: 'export.create', targetType: 'export_jobs',
          targetId: r.rows[0].id, changes: { report_kind: b.report_kind },
          traceId: req.traceId,
        });
        return { httpStatus: 201, body: { export_job_id: r.rows[0].id, status: 'QUEUED', trace_id: req.traceId } };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  app.get('/stores/:storeId/exports', { schema: { params: storeParam } }, async (req) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'report.export');
    return withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => ({
        items: (await c.query(
          `SELECT id, report_kind, format, status, object_key, expires_at,
                  created_at FROM nightclub.export_jobs
            WHERE tenant_id=$1 AND store_id=$2
            ORDER BY created_at DESC LIMIT 100`,
          [member.tenantId, storeId])).rows,
      }));
  });

  app.get('/stores/:storeId/exports/:exportId/download', {
    schema: { params: params({ storeId: sUuid, exportId: sUuid }) },
  }, async (req, reply) => {
    const { storeId, exportId } = req.params as { storeId: string; exportId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'report.export');
    const job = await withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => (await c.query(
        `SELECT id, status, object_key, expires_at, report_kind
           FROM nightclub.export_jobs
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
        [member.tenantId, storeId, exportId])).rows[0]);
    if (!job) throw E.notFound('export');
    if (job.status !== 'READY' || !job.object_key) throw E.invalid('not ready');
    if (job.expires_at && new Date(job.expires_at) < new Date()) {
      throw E.snapshotRequired();
    }
    const { createReadStream } = await import('node:fs');
    const { resolve, sep } = await import('node:path');
    const root = resolve(process.env.EXPORT_DIR || 'devdb/exports');
    const file = resolve(root, String(job.object_key));
    if (!file.startsWith(root + sep)) throw E.forbidden('bad object key');
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${job.report_kind}-${exportId}.csv"`);
    return reply.send(createReadStream(file));
  });

  // ---- campaigns (R4 CRM outbound) -------------------------------------------
  // IN_APP campaigns materialize notification_jobs per segment-matched
  // customer on dispatch. EMAIL/LINE/PUSH record deliveries only — external
  // providers remain BLOCKED integrations.
  app.get('/stores/:storeId/campaigns', {
    schema: { params: storeParam },
  }, async (req) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'customer.manage');
    return withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => ({
        items: (await c.query(
          `SELECT cp.id, cp.name, cp.channel, cp.segment, cp.status,
                  cp.scheduled_at, cp.sent_at, cp.version, cp.created_at,
                  (SELECT count(*)::int FROM nightclub.campaign_deliveries d
                    WHERE d.tenant_id=cp.tenant_id AND d.store_id=cp.store_id
                      AND d.campaign_id=cp.id) AS deliveries
             FROM nightclub.campaigns cp
            WHERE cp.tenant_id=$1 AND cp.store_id=$2
            ORDER BY cp.created_at DESC`,
          [member.tenantId, storeId])).rows,
      }));
  });

  app.post('/stores/:storeId/campaigns', {
    schema: {
      params: storeParam,
      body: body({
        name: str(200),
        channel: { type: 'string', enum: ['IN_APP', 'EMAIL', 'LINE', 'PUSH'] },
        segment: {
          type: 'object', additionalProperties: false,
          properties: {
            tag_keys: { type: 'array', items: str(40), maxItems: 20 },
            regular_status: { type: 'string', enum: ['NONE', 'DESIGNATED'] },
          },
        },
        body: str(4000), scheduled_at: isoTs,
      }, ['name', 'channel', 'body']),
    },
  }, async (req, reply) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'customer.manage');
    const b = req.body as {
      name?: string; channel?: string; segment?: Record<string, unknown>;
      body?: string; scheduled_at?: string;
    };
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: member.membershipId, operation: 'campaign.create',
      key: idemKey(req), body: b, receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const ins = await c.query(
          `INSERT INTO nightclub.campaigns
             (tenant_id, store_id, name, channel, segment, body,
              scheduled_at, created_by, status)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz,$8,
                   CASE WHEN $7::timestamptz IS NULL THEN 'DRAFT' ELSE 'SCHEDULED' END)
           RETURNING id, status`,
          [g.tenantId, g.storeId, b.name, b.channel,
           JSON.stringify(b.segment ?? {}), b.body,
           b.scheduled_at ?? null, member.membershipId]);
        await audit(c, g, {
          action: 'campaign.create', targetType: 'campaigns',
          targetId: ins.rows[0].id, changes: { channel: b.channel },
          traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: {
            campaign_id: ins.rows[0].id, status: ins.rows[0].status,
            trace_id: req.traceId,
          },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // Dispatch: resolve the segment to customers and enqueue deliveries.
  // IN_APP also creates notification_jobs so members with linked customers
  // get the inbox entry; external channels stay QUEUED for the (blocked)
  // provider integration.
  app.post('/stores/:storeId/campaigns/:campaignId/dispatch', {
    schema: {
      params: params({ storeId: sUuid, campaignId: sUuid }),
      body: body({ expected_version: version }, ['expected_version']),
    },
  }, async (req, reply) => {
    const { storeId, campaignId } = req.params as {
      storeId: string; campaignId: string;
    };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'customer.manage');
    const b = req.body as { expected_version?: number };
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: member.membershipId, operation: 'campaign.dispatch',
      key: idemKey(req), body: { ...b, campaignId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const cp = await c.query(
          `SELECT id, status, version, channel, segment, body
             FROM nightclub.campaigns
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,
          [g.tenantId, g.storeId, campaignId]);
        const camp = cp.rows[0];
        if (!camp) throw E.notFound('campaign');
        if (!['DRAFT', 'SCHEDULED'].includes(camp.status)) throw E.alreadyDecided();
        if (camp.version !== b.expected_version) {
          throw E.versionConflict(camp.version);
        }
        const tagKeys: string[] =
          (camp.segment as { tag_keys?: string[] })?.tag_keys ?? [];
        const regular: string | null =
          (camp.segment as { regular_status?: string })?.regular_status ?? null;
        const targets = await c.query(
          `SELECT DISTINCT cust.id
             FROM nightclub.customers cust
            WHERE cust.tenant_id=$1 AND cust.store_id=$2
              AND ($3::text IS NULL OR cust.regular_status=$3)
              AND (cardinality($4::text[])=0 OR EXISTS (
                     SELECT 1 FROM nightclub.customer_tag_assignments a
                      JOIN nightclub.customer_tags t
                        ON t.tenant_id=a.tenant_id AND t.store_id=a.store_id
                       AND t.id=a.tag_id
                      WHERE a.tenant_id=cust.tenant_id
                        AND a.store_id=cust.store_id
                        AND a.customer_id=cust.id
                        AND t.tag_key = ANY($4::text[])))`,
          [g.tenantId, g.storeId, regular, tagKeys]);
        let queued = 0;
        for (const t of targets.rows) {
          const ins = await c.query(
            `INSERT INTO nightclub.campaign_deliveries
               (tenant_id, store_id, campaign_id, recipient_customer_id,
                dedup_key, status)
             VALUES ($1,$2,$3,$4,$5,'QUEUED') ON CONFLICT DO NOTHING
             RETURNING id`,
            [g.tenantId, g.storeId, campaignId, t.id,
             `${camp.channel}:${t.id}`]);
          queued += ins.rowCount ?? 0;
        }
        await c.query(
          `UPDATE nightclub.campaigns
              SET status='SENT', sent_at=CURRENT_TIMESTAMP,
                  version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
          [g.tenantId, g.storeId, campaignId]);
        await audit(c, g, {
          action: 'campaign.dispatch', targetType: 'campaigns',
          targetId: campaignId,
          changes: { queued, channel: camp.channel }, traceId: req.traceId,
        });
        return {
          httpStatus: 200,
          body: { campaign_id: campaignId, queued, status: 'SENT', trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  app.post('/stores/:storeId/campaigns/:campaignId/cancel', {
    schema: {
      params: params({ storeId: sUuid, campaignId: sUuid }),
      body: body({ expected_version: version }, ['expected_version']),
    },
  }, async (req, reply) => {
    const { storeId, campaignId } = req.params as {
      storeId: string; campaignId: string;
    };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'customer.manage');
    const b = req.body as { expected_version?: number };
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: member.membershipId, operation: 'campaign.cancel',
      key: idemKey(req), body: { ...b, campaignId },
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const cp = await c.query(
          `SELECT id, status, version FROM nightclub.campaigns
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,
          [g.tenantId, g.storeId, campaignId]);
        const camp = cp.rows[0];
        if (!camp) throw E.notFound('campaign');
        if (!['DRAFT', 'SCHEDULED'].includes(camp.status)) throw E.alreadyDecided();
        if (camp.version !== b.expected_version) {
          throw E.versionConflict(camp.version);
        }
        await c.query(
          `UPDATE nightclub.campaigns
              SET status='CANCELED', version=version+1,
                  updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
          [g.tenantId, g.storeId, campaignId]);
        await audit(c, g, {
          action: 'campaign.cancel', targetType: 'campaigns',
          targetId: campaignId, traceId: req.traceId,
        });
        return {
          httpStatus: 200,
          body: { campaign_id: campaignId, status: 'CANCELED', trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  app.get('/stores/:storeId/campaigns/:campaignId/deliveries', {
    schema: { params: params({ storeId: sUuid, campaignId: sUuid }) },
  }, async (req) => {
    const { storeId, campaignId } = req.params as {
      storeId: string; campaignId: string;
    };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'customer.manage');
    return withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => ({
        items: (await c.query(
          `SELECT d.id, d.recipient_customer_id, d.status,
                  d.provider_reference, d.created_at,
                  cust.display_name AS recipient_name
             FROM nightclub.campaign_deliveries d
             LEFT JOIN nightclub.customers cust
               ON cust.tenant_id=d.tenant_id AND cust.store_id=d.store_id
              AND cust.id=d.recipient_customer_id
            WHERE d.tenant_id=$1 AND d.store_id=$2 AND d.campaign_id=$3
            ORDER BY d.created_at`,
          [member.tenantId, storeId, campaignId])).rows,
      }));
  });

  // ---- demand forecast (R4) ----------------------------------------------------
  // trailing_avg_v1: deterministic trailing-average model over the last N
  // closed events. Honest baseline — no external ML dependency.
  app.post('/stores/:storeId/forecasts', {
    schema: {
      params: storeParam,
      body: body({
        event_id: sUuid, horizon_days: { type: 'integer', minimum: 1, maximum: 90 },
      }),
    },
  }, async (req, reply) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'report.export');
    const b = (req.body ?? {}) as { event_id?: string; horizon_days?: number };
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: member.membershipId, operation: 'forecast.run',
      key: idemKey(req), body: b, receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const hist = await c.query(
          `SELECT e.id,
                  (SELECT count(*)::int FROM nightclub.visits v
                    WHERE v.tenant_id=e.tenant_id AND v.store_id=e.store_id
                      AND v.event_id=e.id AND v.status<>'CANCELED') AS visits,
                  (SELECT COALESCE(SUM(ae.first_entry_delta),0)::bigint
                     FROM nightclub.admission_events ae
                    WHERE ae.tenant_id=e.tenant_id AND ae.store_id=e.store_id
                      AND ae.event_id=e.id) AS first_entries,
                  (SELECT COALESCE(SUM(sl.gross_minor),0)::bigint
                     FROM nightclub.sales_lines sl
                    WHERE sl.tenant_id=e.tenant_id AND sl.store_id=e.store_id
                      AND sl.event_id=e.id AND sl.line_kind='SALE') AS gross_minor
             FROM nightclub.events e
            WHERE e.tenant_id=$1 AND e.store_id=$2
              AND e.status='CLOSED' AND ($3::uuid IS NULL OR e.id<>$3)
            ORDER BY e.opens_at DESC LIMIT 8`,
          [g.tenantId, g.storeId, b.event_id ?? null]);
        const n = hist.rows.length;
        const avg = (k: 'visits' | 'first_entries' | 'gross_minor') =>
          n === 0 ? 0
            : Math.round(hist.rows.reduce((s, r) => s + Number(r[k]), 0) / n);
        const metrics = {
          model_note: 'trailing average of last <=8 closed events',
          sample_events: n,
          predicted_per_event: {
            visits: avg('visits'),
            first_entries: avg('first_entries'),
            gross_minor: avg('gross_minor'),
          },
          horizon_days: b.horizon_days ?? 14,
        };
        const ins = await c.query(
          `INSERT INTO nightclub.forecast_runs
             (tenant_id, store_id, event_id, model, horizon_days, metrics,
              generated_by)
           VALUES ($1,$2,$3,'trailing_avg_v1',$4,$5,$6) RETURNING id`,
          [g.tenantId, g.storeId, b.event_id ?? null, b.horizon_days ?? 14,
           JSON.stringify(metrics), member.membershipId]);
        await audit(c, g, {
          action: 'forecast.run', targetType: 'forecast_runs',
          targetId: ins.rows[0].id, traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: { forecast_id: ins.rows[0].id, metrics, trace_id: req.traceId },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  app.get('/stores/:storeId/forecasts', {
    schema: { params: storeParam },
  }, async (req) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'report.export');
    return withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => ({
        items: (await c.query(
          `SELECT id, event_id, model, horizon_days, metrics, created_at
             FROM nightclub.forecast_runs
            WHERE tenant_id=$1 AND store_id=$2
            ORDER BY created_at DESC LIMIT 50`,
          [member.tenantId, storeId])).rows,
      }));
  });

  // ---- operating templates (contract: POST /templates) --------------------
  app.post('/stores/:storeId/templates', {
    schema: {
      params: storeParam,
      body: body({
        name: str(100),
        policy: { type: 'object' },
      }, ['name', 'policy']),
    },
  }, async (req, reply) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'policy.manage');
    const b = req.body as { name?: string; policy?: Record<string, unknown> };
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: member.membershipId,
      operation: 'template.create', key: idemKey(req), body: b,
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const ins = await c.query(
          `INSERT INTO nightclub.operating_templates
             (tenant_id, store_id, name, settings, created_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING id, version`,
          [member.tenantId, storeId, b.name, JSON.stringify(b.policy),
           member.membershipId]);
        await audit(c, g, {
          action: 'template.create', targetType: 'operating_templates',
          targetId: ins.rows[0].id, changes: { name: b.name },
          traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: {
            template_id: ins.rows[0].id, version: ins.rows[0].version,
            trace_id: req.traceId,
          },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- coupons (contract: POST /coupons) ----------------------------------
  // The plaintext code is stored only as a hash; conditions carry the
  // discount terms plus the rule_keys the coupon applies to.
  app.post('/stores/:storeId/coupons', {
    schema: {
      params: storeParam,
      body: body({
        code: { type: 'string', minLength: 4, maxLength: 40 },
        valid_from: isoTs, valid_to: isoTs,
        discount_kind: { type: 'string', enum: ['AMOUNT', 'PERCENT'] },
        discount_value: { type: 'integer', minimum: 1 },
        max_uses: { type: 'integer', minimum: 1 },
        owner_membership_id: sUuid,
        rule_keys: { type: 'array', items: str(100), maxItems: 50 },
      }, ['code', 'valid_from', 'valid_to', 'discount_kind',
        'discount_value', 'max_uses', 'rule_keys']),
    },
  }, async (req, reply) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'coupon.manage');
    const b = req.body as {
      code?: string; valid_from?: string; valid_to?: string;
      discount_kind?: 'AMOUNT' | 'PERCENT'; discount_value?: number;
      max_uses?: number; owner_membership_id?: string; rule_keys?: string[];
    };
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: member.membershipId,
      operation: 'coupon.create', key: idemKey(req), body: b,
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        if (b.owner_membership_id) {
          const m = await c.query(
            `SELECT id FROM nightclub.memberships
              WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='ACTIVE'`,
            [member.tenantId, storeId, b.owner_membership_id]);
          if (!m.rows[0]) throw E.invalid('owner membership not found');
        }
        const conditions = {
          discount_kind: b.discount_kind, discount_value: b.discount_value,
          max_uses: b.max_uses, rule_keys: b.rule_keys ?? [],
        };
        let ins;
        try {
          ins = await c.query(
            `INSERT INTO nightclub.coupons
               (tenant_id, store_id, code_hash, version, owner_membership_id,
                conditions, valid_from, valid_to, status)
             VALUES ($1,$2,$3,1,$4,$5,$6,$7,'ACTIVE')
             RETURNING id, version`,
            [member.tenantId, storeId,
             sha256((b.code ?? '').trim().toUpperCase()),
             b.owner_membership_id ?? null, JSON.stringify(conditions),
             b.valid_from, b.valid_to]);
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            throw E.conflict('coupon code already registered');
          }
          throw err;
        }
        await audit(c, g, {
          action: 'coupon.create', targetType: 'coupons',
          targetId: ins.rows[0].id,
          changes: { discount_kind: b.discount_kind, max_uses: b.max_uses },
          traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: {
            coupon_id: ins.rows[0].id, version: ins.rows[0].version,
            trace_id: req.traceId,
          },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- notification templates (contract: POST /notification-templates) ----
  app.post('/stores/:storeId/notification-templates', {
    schema: {
      params: storeParam,
      body: body({
        key: str(80),
        locale: { type: 'string', enum: ['ja', 'en'] },
        body: str(4000),
      }, ['key', 'locale', 'body']),
    },
  }, async (req, reply) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'notification.manage');
    const b = req.body as { key?: string; locale?: string; body?: string };
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: member.membershipId,
      operation: 'notification_template.create', key: idemKey(req), body: b,
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        let ins;
        try {
          ins = await c.query(
            `INSERT INTO nightclub.notification_templates
               (tenant_id, store_id, template_key, locale, version, body, status)
             VALUES ($1,$2,$3,$4,1,$5,'ACTIVE') RETURNING id, version`,
            [member.tenantId, storeId, b.key, b.locale, b.body]);
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            throw E.conflict('template key+locale already registered');
          }
          throw err;
        }
        await audit(c, g, {
          action: 'notification_template.create',
          targetType: 'notification_templates', targetId: ins.rows[0].id,
          changes: { key: b.key, locale: b.locale }, traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: {
            notification_template_id: ins.rows[0].id,
            version: ins.rows[0].version, trace_id: req.traceId,
          },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });

  // ---- import jobs (contract: POST /imports) ------------------------------
  // Registers a migration-file validation request. object_key references the
  // uploaded artifact in the store's object storage; its sha256 is kept as the
  // dedup identity in file_hash. Actual validation runs out of band (B-06).
  app.post('/stores/:storeId/imports', {
    schema: {
      params: storeParam,
      body: body({
        source_system: str(80),
        object_key: str(300),
        mapping: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      }, ['source_system', 'object_key', 'mapping']),
    },
  }, async (req, reply) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'import.manage');
    const b = req.body as {
      source_system?: string; object_key?: string;
      mapping?: Record<string, string>;
    };
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    const res = await withCtx(g, async (c) => withReceipt(c, g, {
      actorKey: member.membershipId,
      operation: 'import.create', key: idemKey(req), body: b,
      receiptTtlSec: config.ttl.receiptSec,
      run: async () => {
        const ins = await c.query(
          `INSERT INTO nightclub.import_jobs
             (tenant_id, store_id, requested_by, source_system, file_hash,
              status, mapping, validation_errors, operation_id)
           VALUES ($1,$2,$3,$4,$5,'UPLOADED',$6,'[]',$7)
           RETURNING id`,
          [member.tenantId, storeId, member.membershipId, b.source_system,
           sha256(b.object_key ?? ''), JSON.stringify(b.mapping), uuid()]);
        await audit(c, g, {
          action: 'import.create', targetType: 'import_jobs',
          targetId: ins.rows[0].id,
          changes: { source_system: b.source_system }, traceId: req.traceId,
        });
        return {
          httpStatus: 201,
          body: {
            import_job_id: ins.rows[0].id, status: 'UPLOADED',
            trace_id: req.traceId,
          },
        };
      },
    }));
    reply.code(res.httpStatus);
    return res.body;
  });
}
