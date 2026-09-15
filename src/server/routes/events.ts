// Events, day-of assignments, and policy versions (draft/preview/publish).
import type { FastifyInstance } from 'fastify';
import { createHash, createHmac } from 'node:crypto';
import { config } from '../config.js';
import { withCtx } from '../lib/db.js';
import { E } from '../lib/errors.js';
import { canonicalJson } from '../lib/crypto.js';
import { audit, emit, publishedPolicy, type Policy } from '../lib/tx.js';
import {
  requirePersonal, requirePerm, requireOperator, requireDevice, gucPersonal, gucDevice, gucOperator,
} from '../lib/ctx.js';

const ASSIGNMENT_KINDS = ['REFERRER', 'DESIGNATED_APPROVER', 'ENTRANCE', 'ENTRANCE_APPROVER', 'RESERVATION'];

function previewToken(policy: unknown, eventId: string, eventVersion: number) {
  const h = createHmac('sha256', config.snapshotSecret)
    .update(`preview:${eventId}:${eventVersion}:${createHash('sha256').update(canonicalJson(policy)).digest('hex')}`)
    .digest('base64url');
  return h;
}

// Business validation of a policy document beyond JSON-schema shape.
export function validatePolicy(
  p: Policy['settings'], opts: {
    eventId: string; eventOpens: Date; eventCloses: Date;
    currency: string; memberIds: Set<string>; unlimitedAllowed: boolean;
  },
): { errors: { path: string; code: string; message: string }[] } {
  const errors: { path: string; code: string; message: string }[] = [];
  const add = (path: string, code: string, message: string) =>
    errors.push({ path, code, message });
  if (p.event_id !== opts.eventId) add('event_id', 'MISMATCH', 'event_id does not match path event');
  if (p.currency !== opts.currency) add('currency', 'MISMATCH', 'currency does not match store');
  if (new Date(p.effective_from) >= new Date(p.effective_to)) add('effective_from', 'ORDER', 'effective range inverted');
  if (new Date(p.registration_from) >= new Date(p.registration_to)) add('registration_from', 'ORDER', 'registration range inverted');
  if (new Date(p.registration_to) > opts.eventCloses) add('registration_to', 'ORDER', 'registration ends after close');
  const seen = new Set<string>();
  for (const [i, r] of p.price_rules.entries()) {
    const base = `price_rules[${i}]`;
    if (seen.has(r.rule_key)) add(`${base}.rule_key`, 'DUPLICATE', 'duplicate rule_key');
    seen.add(r.rule_key);
    if (new Date(r.entry_from) >= new Date(r.entry_to)) add(`${base}.entry_from`, 'ORDER', 'entry window inverted');
    if (new Date(r.entry_from) < opts.eventOpens || new Date(r.entry_to) > opts.eventCloses) {
      add(base, 'WINDOW', 'entry window outside event hours');
    }
    if (r.kind === 'FREE' && (r.amount_minor !== 0 || r.payment_required)) {
      add(`${base}.amount_minor`, 'FREE_PRICE', 'FREE rule must be 0 / no payment');
    }
  }
  if (p.limits_unset_block_publish) {
    if (p.event_free_limit.mode === 'UNSET') add('event_free_limit.mode', 'UNSET', 'event free limit unset');
    if (p.max_party_size.mode === 'UNSET') add('max_party_size.mode', 'UNSET', 'max party size unset');
  }
  if (!opts.unlimitedAllowed) {
    if (p.event_free_limit.mode === 'UNLIMITED') add('event_free_limit.mode', 'FORBIDDEN', 'UNLIMITED requires permission');
    if (p.max_party_size.mode === 'UNLIMITED') add('max_party_size.mode', 'FORBIDDEN', 'UNLIMITED requires permission');
  }
  for (const mid of p.approval.designated_member_ids) {
    if (!opts.memberIds.has(mid)) add('approval.designated_member_ids', 'UNKNOWN_MEMBER', `member ${mid} not active in store`);
  }
  if (p.approval.entrance_regular_approval !== true) add('approval.entrance_regular_approval', 'CONST', 'entrance approval must stay enabled');
  return { errors };
}

export default async function eventRoutes(app: FastifyInstance) {
  app.get('/stores/:storeId/events', async (req) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'event.read');
    return withCtx(gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId), async (c) => {
      const r = await c.query(
        `SELECT id, name, opens_at, closes_at, status, version
           FROM nightclub.events WHERE tenant_id=$1 AND store_id=$2
          ORDER BY opens_at DESC`, [member.tenantId, storeId]);
      return { items: r.rows };
    });
  });

  app.post('/stores/:storeId/events', async (req, reply) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'event.manage');
    const b = req.body as { name?: string; opens_at?: string; closes_at?: string; is_private?: boolean };
    if (!b?.name || !b.opens_at || !b.closes_at) throw E.invalid('name, opens_at, closes_at required');
    if (new Date(b.opens_at) >= new Date(b.closes_at)) throw E.invalid('opens_at must precede closes_at');
    const row = await withCtx(gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId), async (c) => {
      const r = await c.query(
        `INSERT INTO nightclub.events (tenant_id, store_id, name, opens_at, closes_at, is_private)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, version, status`,
        [member.tenantId, storeId, b.name, b.opens_at, b.closes_at, b.is_private === true]);
      await audit(c, gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId), {
        action: 'event.create', targetType: 'events', targetId: r.rows[0].id,
        changes: { name: b.name, is_private: b.is_private === true }, traceId: req.traceId,
      });
      return r.rows[0];
    });
    reply.code(201);
    return { id: row.id, name: b.name, opens_at: b.opens_at, closes_at: b.closes_at, status: row.status, version: row.version, is_private: b.is_private === true };
  });

  // Day-of staffing: full replace of an event's assignments.
  app.put('/stores/:storeId/events/:eventId/assignments', async (req) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'event.manage');
    const b = req.body as {
      assignments?: { membership_id: string; assignment_kind: string; starts_at?: string; ends_at?: string }[];
    };
    if (!Array.isArray(b?.assignments)) throw E.invalid('assignments required');
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    return withCtx(g, async (c) => {
      const ev = await c.query(
        `SELECT id, opens_at, closes_at FROM nightclub.events
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,
        [member.tenantId, storeId, eventId]);
      if (!ev.rows[0]) throw E.notFound('event');
      const { opens_at, closes_at } = ev.rows[0];
      await c.query(
        `DELETE FROM nightclub.event_assignments
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3`,
        [member.tenantId, storeId, eventId]);
      for (const a of b.assignments!) {
        if (!ASSIGNMENT_KINDS.includes(a.assignment_kind)) throw E.invalid(`bad kind ${a.assignment_kind}`);
        const m = await c.query(
          `SELECT id FROM nightclub.memberships
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='ACTIVE'`,
          [member.tenantId, storeId, a.membership_id]);
        if (!m.rows[0]) throw E.invalid(`membership ${a.membership_id} not active`);
        await c.query(
          `INSERT INTO nightclub.event_assignments
             (tenant_id, store_id, event_id, membership_id, assignment_kind, starts_at, ends_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [member.tenantId, storeId, eventId, a.membership_id, a.assignment_kind,
           a.starts_at ?? opens_at, a.ends_at ?? closes_at]);
      }
      await audit(c, g, {
        action: 'event.assignments.replace', targetType: 'events', targetId: eventId,
        changes: { count: b.assignments!.length }, traceId: req.traceId,
      });
      await emit(c, g, {
        eventId, eventType: 'assignments.replaced', aggregateType: 'event',
        aggregateId: eventId, aggregateVersion: 1,
        payload: { replaced: true }, traceId: req.traceId,
      });
      return { resource_id: eventId, version: 1, status: 'UPDATED', trace_id: req.traceId };
    });
  });

  // Current published policy.
  app.get('/stores/:storeId/events/:eventId/policy', async (req) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string };
    const op = await req.auth.operator().catch(() => null);
    if (op && op.storeId === storeId && op.eventId === eventId) {
      return withCtx(gucOperator(op), async (c) => {
        const p = await publishedPolicy(c, gucOperator(op), eventId);
        if (!p) throw E.notFound('policy');
        return { policy_version_id: p.id, version: p.version, settings: p.settings };
      });
    }
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'event.read');
    return withCtx(gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId), async (c) => {
      const p = await publishedPolicy(c, gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId), eventId);
      if (!p) throw E.notFound('policy');
      return { policy_version_id: p.id, version: p.version, settings: p.settings };
    });
  });

  // Create a draft policy version.
  app.post('/stores/:storeId/events/:eventId/policy-versions', async (req, reply) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'policy.manage');
    const b = req.body as { expected_event_version?: number; policy?: Policy['settings'] };
    if (!b?.policy || typeof b.expected_event_version !== 'number') {
      throw E.invalid('expected_event_version and policy required');
    }
    const policySettings = b.policy;
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    const out = await withCtx(g, async (c) => {
      const ev = await c.query(
        `SELECT id, version, opens_at, closes_at FROM nightclub.events
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,
        [member.tenantId, storeId, eventId]);
      if (!ev.rows[0]) throw E.notFound('event');
      if (ev.rows[0].version !== b.expected_event_version) {
        throw E.versionConflict(ev.rows[0].version);
      }
      const v = await c.query(
        `SELECT COALESCE(MAX(version),0)+1 AS v FROM nightclub.policy_versions
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3`,
        [member.tenantId, storeId, eventId]);
      const ins = await c.query(
        `INSERT INTO nightclub.policy_versions
           (tenant_id, store_id, event_id, version, status, settings,
            effective_from, effective_to, apply_mode)
         VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8) RETURNING id, version`,
        [member.tenantId, storeId, eventId, v.rows[0].v, JSON.stringify(policySettings),
         policySettings.effective_from, policySettings.effective_to, policySettings.apply_mode]);
      return ins.rows[0];
    });
    reply.code(201);
    return { policy_version_id: out.id, version: out.version, status: 'DRAFT', trace_id: req.traceId };
  });

  // Preview: business validation + impact check -> signed token for publish.
  app.post('/stores/:storeId/events/:eventId/policy-versions/:policyId/preview', async (req) => {
    const { storeId, eventId, policyId } = req.params as { storeId: string; eventId: string; policyId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'policy.manage');
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    return withCtx(g, async (c) => {
      const ev = await c.query(
        `SELECT e.id, e.version, e.opens_at, e.closes_at, s.currency
           FROM nightclub.events e JOIN nightclub.stores s
             ON s.tenant_id=e.tenant_id AND s.id=e.store_id
          WHERE e.tenant_id=$1 AND e.store_id=$2 AND e.id=$3`,
        [member.tenantId, storeId, eventId]);
      if (!ev.rows[0]) throw E.notFound('event');
      const pv = await c.query(
        `SELECT id, version, status, settings FROM nightclub.policy_versions
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4`,
        [member.tenantId, storeId, eventId, policyId]);
      if (!pv.rows[0]) throw E.notFound('policy version');
      const p = pv.rows[0].settings as Policy['settings'];
      const members = await c.query(
        `SELECT id FROM nightclub.memberships WHERE tenant_id=$1 AND store_id=$2 AND status='ACTIVE'`,
        [member.tenantId, storeId]);
      const { errors } = validatePolicy(p, {
        eventId,
        eventOpens: new Date(ev.rows[0].opens_at),
        eventCloses: new Date(ev.rows[0].closes_at),
        currency: ev.rows[0].currency,
        memberIds: new Set(members.rows.map((m) => m.id)),
        unlimitedAllowed: member.permissions.has('policy.override_hard_limit'),
      });
      const ok = errors.length === 0;
      return {
        preview_token: ok ? previewToken(p, eventId, ev.rows[0].version) : null,
        ok, errors,
        affected: { unentered_segments: 0 },
      };
    });
  });

  // Publish: requires preview token + expected event version.
  app.post('/stores/:storeId/events/:eventId/policy-versions/:policyId/publish', async (req) => {
    const { storeId, eventId, policyId } = req.params as { storeId: string; eventId: string; policyId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'policy.manage');
    const b = req.body as { expected_version?: number; preview_token?: string; apply_mode?: string };
    if (typeof b?.expected_version !== 'number' || !b.preview_token) {
      throw E.invalid('expected_version and preview_token required');
    }
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    return withCtx(g, async (c) => {
      const ev = await c.query(
        `SELECT id, version, opens_at, closes_at FROM nightclub.events
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,
        [member.tenantId, storeId, eventId]);
      if (!ev.rows[0]) throw E.notFound('event');
      if (ev.rows[0].version !== b.expected_version) throw E.versionConflict(ev.rows[0].version);
      const pv = await c.query(
        `SELECT id, version, status, settings FROM nightclub.policy_versions
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$4 FOR UPDATE`,
        [member.tenantId, storeId, eventId, policyId]);
      if (!pv.rows[0]) throw E.notFound('policy version');
      const p = pv.rows[0].settings as Policy['settings'];
      if (previewToken(p, eventId, ev.rows[0].version) !== b.preview_token) {
        throw E.previewStale();
      }
      if (pv.rows[0].status !== 'DRAFT') throw E.invalid('policy already published');
      const applyMode = b.apply_mode ?? p.apply_mode;
      if (applyMode === 'REASSESS_UNENTERED') {
        const affected = await c.query(
          `SELECT count(*)::int AS n FROM nightclub.admission_segments s
             JOIN nightclub.visits v ON v.tenant_id=s.tenant_id AND v.store_id=s.store_id
              AND v.event_id=s.event_id AND v.id=s.visit_id
            WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.event_id=$3
              AND s.status IN ('PENDING','AUTHORIZED')`,
          [member.tenantId, storeId, eventId]);
        if (affected.rows[0].n > 0) {
          // R1: no partial re-judgment; operator must split/close first.
          throw E.validation('REASSESS_UNENTERED blocked: unentered segments exist', [{
            path: 'apply_mode', code: 'AFFECTED_ROWS',
            message: `${affected.rows[0].n} unentered segment(s) affected`,
          }]);
        }
      }
      // Re-validate at publish (settings could be shared/stale).
      const members = await c.query(
        `SELECT id FROM nightclub.memberships WHERE tenant_id=$1 AND store_id=$2 AND status='ACTIVE'`,
        [member.tenantId, storeId]);
      const st = await c.query('SELECT currency FROM nightclub.stores WHERE tenant_id=$1 AND id=$2', [member.tenantId, storeId]);
      const { errors } = validatePolicy(p, {
        eventId, eventOpens: new Date(ev.rows[0].opens_at), eventCloses: new Date(ev.rows[0].closes_at),
        currency: st.rows[0].currency,
        memberIds: new Set(members.rows.map((m) => m.id)),
        unlimitedAllowed: member.permissions.has('policy.override_hard_limit'),
      });
      if (errors.length) throw E.validation('policy invalid', errors);

      await c.query(
        `UPDATE nightclub.policy_versions SET status='SUPERSEDED', updated_at=CURRENT_TIMESTAMP
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND status='PUBLISHED'`,
        [member.tenantId, storeId, eventId]);
      await c.query(
        `UPDATE nightclub.policy_versions SET status='PUBLISHED', published_by=$4,
            published_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND id=$5`,
        [member.tenantId, storeId, eventId, member.membershipId, policyId]);
      // Materialize price rules.
      await c.query(
        `DELETE FROM nightclub.price_rules
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND policy_version_id=$4`,
        [member.tenantId, storeId, eventId, policyId]);
      for (const r of p.price_rules) {
        await c.query(
          `INSERT INTO nightclub.price_rules
             (tenant_id, store_id, event_id, policy_version_id, rule_key,
              price_kind, amount_minor, currency, entry_from, entry_to, payment_required)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [member.tenantId, storeId, eventId, policyId, r.rule_key, r.kind,
           r.amount_minor, p.currency, r.entry_from, r.entry_to, r.payment_required]);
      }
      // Buckets: event free cap (EVENT_HARD) + manual-decider + actor/customer lazily.
      const freeMode = p.event_free_limit.mode;
      if (freeMode !== 'UNSET') {
        await c.query(
          `INSERT INTO nightclub.quota_buckets
             (tenant_id, store_id, event_id, bucket_key, bucket_kind, limit_mode, limit_count)
           VALUES ($1,$2,$3,'event_free','EVENT_HARD',$4,$5)
           ON CONFLICT (tenant_id, store_id, event_id, bucket_key)
           DO UPDATE SET limit_mode=EXCLUDED.limit_mode, limit_count=EXCLUDED.limit_count`,
          [member.tenantId, storeId, eventId,
           freeMode === 'UNLIMITED' ? 'UNLIMITED' : 'LIMITED',
           freeMode === 'LIMITED' ? p.event_free_limit.value : null]);
      }
      await c.query(
        `INSERT INTO nightclub.quota_buckets
           (tenant_id, store_id, event_id, bucket_key, bucket_kind, limit_mode, limit_count)
         VALUES ($1,$2,$3,'manual','MANUAL_DECIDER','UNLIMITED',NULL)
         ON CONFLICT DO NOTHING`,
        [member.tenantId, storeId, eventId]);
      // Designated approvers become event assignments.
      for (const mid of p.approval.designated_member_ids) {
        await c.query(
          `INSERT INTO nightclub.event_assignments
             (tenant_id, store_id, event_id, membership_id, assignment_kind, starts_at, ends_at)
           VALUES ($1,$2,$3,$4,'DESIGNATED_APPROVER',$5,$6)
           ON CONFLICT (tenant_id, store_id, event_id, membership_id, assignment_kind) DO NOTHING`,
          [member.tenantId, storeId, eventId, mid, ev.rows[0].opens_at, ev.rows[0].closes_at]);
      }
      await audit(c, g, {
        action: 'policy.publish', targetType: 'policy_versions', targetId: policyId,
        changes: { apply_mode: applyMode }, traceId: req.traceId,
      });
      await emit(c, g, {
        eventId, eventType: 'policy.published', aggregateType: 'policy_version',
        aggregateId: policyId, aggregateVersion: pv.rows[0].version,
        payload: { version: pv.rows[0].version }, traceId: req.traceId,
      });
      return { resource_id: policyId, version: pv.rows[0].version, status: 'PUBLISHED', trace_id: req.traceId };
    });
  });

  // Publish the event itself (open for registration/entrance work).
  app.post('/stores/:storeId/events/:eventId/publish', async (req) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'event.manage');
    const b = (req.body ?? {}) as { expected_version?: number };
    const g = gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId);
    return withCtx(g, async (c) => {
      const ev = await c.query(
        `SELECT id, version, status FROM nightclub.events
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,
        [member.tenantId, storeId, eventId]);
      if (!ev.rows[0]) throw E.notFound('event');
      if (ev.rows[0].version !== b.expected_version) throw E.versionConflict(ev.rows[0].version);
      const pol = await publishedPolicy(c, g, eventId);
      if (!pol) throw E.configIncomplete('no published policy');
      const upd = await c.query(
        `UPDATE nightclub.events SET status='PUBLISHED', version=version+1,
            updated_at=CURRENT_TIMESTAMP
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3 RETURNING version`,
        [member.tenantId, storeId, eventId]);
      await audit(c, g, {
        action: 'event.publish', targetType: 'events', targetId: eventId,
        afterVersion: upd.rows[0].version, traceId: req.traceId,
      });
      await emit(c, g, {
        eventId, eventType: 'event.published', aggregateType: 'event',
        aggregateId: eventId, aggregateVersion: upd.rows[0].version,
        payload: {}, traceId: req.traceId,
      });
      return { resource_id: eventId, version: upd.rows[0].version, status: 'PUBLISHED', trace_id: req.traceId };
    });
  });

  // Operator-facing event info (kiosk header).
  app.get('/device/event', async (req) => {
    const d = await requireDevice(req);
    const q = req.query as { event_id?: string };
    if (!q.event_id) throw E.invalid('event_id required');
    return withCtx(gucDevice(d, q.event_id), async (c) => {
      const r = await c.query(
        `SELECT id, name, opens_at, closes_at, status FROM nightclub.events
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
        [d.tenantId, d.storeId, q.event_id]);
      if (!r.rows[0]) throw E.notFound('event');
      return r.rows[0];
    });
  });

  void requireOperator; // referenced by later modules via ctx lib
}
