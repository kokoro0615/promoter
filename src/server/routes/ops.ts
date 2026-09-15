// Operations slice: permits, reward rules, audit read, exports, settlement.
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { withCtx } from '../lib/db.js';
import { E } from '../lib/errors.js';
import { uuid } from '../lib/crypto.js';
import { audit, emit, idemKey, withReceipt } from '../lib/tx.js';
import {
  requirePersonal, requirePerm, gucPersonal,
} from '../lib/ctx.js';

export default async function opsRoutes(app: FastifyInstance) {
  // ---- permits ----
  app.post('/stores/:storeId/permits', async (req, reply) => {
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

  app.get('/stores/:storeId/permits', async (req) => {
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
  app.post('/stores/:storeId/permits/:permitId/preview-revocation', async (req) => {
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

  app.post('/stores/:storeId/permits/:permitId/revoke', async (req) => {
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
  app.post('/stores/:storeId/reward-rules', async (req, reply) => {
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
  app.get('/stores/:storeId/audit-logs', async (req) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'audit.read');
    const q = req.query as { target_type?: string; target_id?: string; limit?: string };
    return withCtx(gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId), async (c) => {
      const r = await c.query(
        `SELECT id, actor_membership_id, device_id, operator_session_id,
                action, target_type, target_id, changes, reason, trace_id, created_at
           FROM nightclub.audit_logs
          WHERE tenant_id=$1 AND store_id=$2
            AND ($3::text IS NULL OR target_type=$3)
            AND ($4::uuid IS NULL OR target_id=$4)
          ORDER BY created_at DESC LIMIT $5`,
        [member.tenantId, storeId, q.target_type ?? null,
         q.target_id ?? null, Math.min(Number(q.limit) || 100, 500)]);
      return { items: r.rows };
    });
  });

  // ---- provisional entries (offline reconciliation intake) ----
  app.post('/stores/:storeId/events/:eventId/provisional-entries/import', async (req, reply) => {
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

  // ---- settlements (build + finalize) ----
  app.post('/stores/:storeId/events/:eventId/settlements', async (req, reply) => {
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

  app.post('/stores/:storeId/events/:eventId/settlements/:settlementId/finalize', async (req) => {
    const { storeId, eventId, settlementId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'settlement.finalize');
    const b = req.body as { expected_version?: number };
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    return withCtx(g, async (c) => {
      const r = await c.query(
        `UPDATE nightclub.settlements SET status='FINALIZED',
            finalized_by=$5, finalized_at=CURRENT_TIMESTAMP,
            updated_at=CURRENT_TIMESTAMP
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
  app.post('/stores/:storeId/exports', async (req, reply) => {
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

  app.get('/stores/:storeId/exports', async (req) => {
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

  app.get('/stores/:storeId/exports/:exportId/download', async (req, reply) => {
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
}
