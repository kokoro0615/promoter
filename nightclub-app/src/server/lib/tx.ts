// In-transaction helpers shared by command handlers:
// audit rows, outbox emission (same-TX as business write), idempotency
// receipts, published-policy loading and quota holds.
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Client, Guc } from './db.js';
import { E, AppError } from './errors.js';
import { canonicalJson, uuid } from './crypto.js';

export async function audit(
  c: Client, g: Guc, a: {
    action: string; targetType: string; targetId: string;
    beforeVersion?: number | null; afterVersion?: number | null;
    changes?: unknown; reason?: string | null; traceId: string;
  },
) {
  await c.query(
    `INSERT INTO nightclub.audit_logs
       (tenant_id, store_id, actor_membership_id, device_id, operator_session_id,
        action, target_type, target_id, before_version, after_version,
        changes, reason, trace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      g.tenantId, g.storeId, g.memberId, g.deviceId, g.operatorSessionId,
      a.action, a.targetType, a.targetId, a.beforeVersion ?? null,
      a.afterVersion ?? null, JSON.stringify(a.changes ?? {}),
      a.reason ?? null, a.traceId,
    ]);
}

// Append to the event stream: lock the stream head, seq = last+1, insert
// outbox row in the SAME transaction as the business write.
export async function emit(
  c: Client, g: Guc, e: {
    eventId: string; eventType: string; aggregateType: string;
    aggregateId: string; aggregateVersion: number; payload: unknown;
    traceId: string;
  },
) {
  await c.query(
    `INSERT INTO nightclub.event_stream_heads (tenant_id, store_id, event_id, last_seq)
     VALUES ($1,$2,$3,0)
     ON CONFLICT (tenant_id, store_id, event_id) DO NOTHING`,
    [g.tenantId, g.storeId, e.eventId]);
  const h = await c.query(
    `UPDATE nightclub.event_stream_heads SET last_seq = last_seq + 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3
      RETURNING last_seq`,
    [g.tenantId, g.storeId, e.eventId]);
  const seq = h.rows[0].last_seq as number;
  await c.query(
    `INSERT INTO nightclub.outbox_events
       (tenant_id, store_id, event_id, stream_seq, event_type, aggregate_type,
        aggregate_id, aggregate_version, payload, trace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      g.tenantId, g.storeId, e.eventId, seq, e.eventType, e.aggregateType,
      e.aggregateId, e.aggregateVersion, JSON.stringify(e.payload), e.traceId,
    ]);
  return seq;
}

// ---- idempotency (command_receipts) ----
export interface ReceiptResult<T> { replayed: boolean; value: T }

// Run `handler` inside the caller's open transaction with idempotency
// semantics keyed on (actor, operation, Idempotency-Key).
export async function withReceipt<T>(
  c: Client, g: Guc, args: {
    actorKey: string; operation: string; key: string; body: unknown;
    receiptTtlSec: number;
    run: () => Promise<{ httpStatus: number; body: T }>;
  },
): Promise<{ httpStatus: number; body: T; replayed: boolean }> {
  const reqHash = createHash('sha256').update(canonicalJson(args.body)).digest('hex');
  const ins = await c.query(
    `INSERT INTO nightclub.command_receipts
       (tenant_id, store_id, actor_key, operation_key, operation_name,
        request_hash, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,'PROCESSING', CURRENT_TIMESTAMP + make_interval(secs => $7))
     ON CONFLICT (tenant_id, store_id, actor_key, operation_name, operation_key)
     DO NOTHING RETURNING id`,
    [g.tenantId, g.storeId, args.actorKey, args.key, args.operation, reqHash,
     args.receiptTtlSec]);
  if (!ins.rows[0]) {
    const ex = await c.query(
      `SELECT request_hash, status, http_status, response_body
         FROM nightclub.command_receipts
        WHERE tenant_id=$1 AND store_id=$2 AND actor_key=$3
          AND operation_name=$4 AND operation_key=$5`,
      [g.tenantId, g.storeId, args.actorKey, args.operation, args.key]);
    const r = ex.rows[0];
    if (r.request_hash !== reqHash) throw E.idempotencyConflict();
    if (r.status === 'PROCESSING') throw E.commandInProgress();
    return {
      httpStatus: r.http_status ?? 200,
      body: r.response_body as T,
      replayed: true,
    };
  }
  // Handler runs under a savepoint: business AppErrors roll back only the
  // business writes, while the receipt row (inserted before the savepoint)
  // survives and is committed with the stored rejection response.
  await c.query('SAVEPOINT nc_command');
  try {
    const res = await args.run();
    await c.query('RELEASE SAVEPOINT nc_command');
    await c.query(
      `UPDATE nightclub.command_receipts
          SET status='SUCCEEDED', http_status=$2, response_body=$3,
              version=version+1, updated_at=CURRENT_TIMESTAMP
        WHERE id=$1`,
      [ins.rows[0].id, res.httpStatus, JSON.stringify(res.body)]);
    return { ...res, replayed: false };
  } catch (e) {
    if (e instanceof AppError) {
      await c.query('ROLLBACK TO SAVEPOINT nc_command');
      const body = {
        type: `urn:nc:${e.code}`, title: e.code, status: e.status,
        code: e.code, detail: e.message,
        current_version: e.opts.currentVersion ?? null,
        retryable: e.opts.retryable ?? false,
        field_errors: e.opts.fieldErrors ?? null,
      };
      await c.query(
        `UPDATE nightclub.command_receipts
            SET status='REJECTED', http_status=$2, response_body=$3,
                version=version+1, updated_at=CURRENT_TIMESTAMP
          WHERE id=$1`,
        [ins.rows[0].id, e.status, JSON.stringify(body)]);
      return { httpStatus: e.status, body: body as T, replayed: false };
    }
    throw e;
  }
}

// ---- platform-scope variants (R2 SaaS console) ----
// Platform commands are cross-tenant: command_receipts/audit_logs require
// NOT NULL (tenant_id, store_id), so platform_command_receipts /
// platform_audit_logs carry the same semantics without tenant keys.
export async function platformAudit(
  c: Client, a: {
    actorUserId: string; tenantId?: string | null;
    action: string; targetType: string; targetId: string;
    beforeVersion?: number | null; afterVersion?: number | null;
    changes?: unknown; reason?: string | null; traceId: string;
  },
) {
  await c.query(
    `INSERT INTO nightclub.platform_audit_logs
       (tenant_id, actor_user_id, action, target_type, target_id,
        before_version, after_version, changes, reason, trace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      a.tenantId ?? null, a.actorUserId, a.action, a.targetType, a.targetId,
      a.beforeVersion ?? null, a.afterVersion ?? null,
      JSON.stringify(a.changes ?? {}), a.reason ?? null, a.traceId,
    ]);
}

export async function platformReceipt<T>(
  c: Client, args: {
    actorKey: string; operation: string; key: string; body: unknown;
    receiptTtlSec: number;
    run: () => Promise<{ httpStatus: number; body: T }>;
  },
): Promise<{ httpStatus: number; body: T; replayed: boolean }> {
  const reqHash = createHash('sha256').update(canonicalJson(args.body)).digest('hex');
  const ins = await c.query(
    `INSERT INTO nightclub.platform_command_receipts
       (actor_key, operation_key, operation_name, request_hash, status, expires_at)
     VALUES ($1,$2,$3,$4,'PROCESSING', CURRENT_TIMESTAMP + make_interval(secs => $5))
     ON CONFLICT (actor_key, operation_name, operation_key)
     DO NOTHING RETURNING id`,
    [args.actorKey, args.key, args.operation, reqHash, args.receiptTtlSec]);
  if (!ins.rows[0]) {
    const ex = await c.query(
      `SELECT request_hash, status, http_status, response_body
         FROM nightclub.platform_command_receipts
        WHERE actor_key=$1 AND operation_name=$2 AND operation_key=$3`,
      [args.actorKey, args.operation, args.key]);
    const r = ex.rows[0];
    if (r.request_hash !== reqHash) throw E.idempotencyConflict();
    if (r.status === 'PROCESSING') throw E.commandInProgress();
    return { httpStatus: r.http_status ?? 200, body: r.response_body as T, replayed: true };
  }
  await c.query('SAVEPOINT nc_command');
  try {
    const res = await args.run();
    await c.query('RELEASE SAVEPOINT nc_command');
    await c.query(
      `UPDATE nightclub.platform_command_receipts
          SET status='SUCCEEDED', http_status=$2, response_body=$3,
              version=version+1, updated_at=CURRENT_TIMESTAMP
        WHERE id=$1`,
      [ins.rows[0].id, res.httpStatus, JSON.stringify(res.body)]);
    return { ...res, replayed: false };
  } catch (e) {
    if (e instanceof AppError) {
      await c.query('ROLLBACK TO SAVEPOINT nc_command');
      const body = {
        type: `urn:nc:${e.code}`, title: e.code, status: e.status,
        code: e.code, detail: e.message,
        current_version: e.opts.currentVersion ?? null,
        retryable: e.opts.retryable ?? false,
        field_errors: e.opts.fieldErrors ?? null,
      };
      await c.query(
        `UPDATE nightclub.platform_command_receipts
            SET status='REJECTED', http_status=$2, response_body=$3,
                version=version+1, updated_at=CURRENT_TIMESTAMP
          WHERE id=$1`,
        [ins.rows[0].id, e.status, JSON.stringify(body)]);
      return { httpStatus: e.status, body: body as T, replayed: false };
    }
    throw e;
  }
}

export function idemKey(req: FastifyRequest): string {
  const k = req.headers['idempotency-key'];
  if (typeof k !== 'string' || !k || k.length > 200) {
    throw E.invalid('Idempotency-Key header required');
  }
  return k;
}

// ---- policy ----
export interface PolicyRule {
  rule_key: string; label: string; kind: 'NORMAL' | 'DISCOUNT' | 'FREE';
  amount_minor: number; entry_from: string; entry_to: string;
  payment_required: boolean; standard_allowed: boolean;
}
export interface Policy {
  id: string; version: number; settings: {
    schema_version: string; environment?: string;
    event_id: string; timezone: string; currency: string;
    effective_from: string; effective_to: string;
    registration_from: string; registration_to: string;
    apply_mode: 'NEW_ONLY' | 'REASSESS_UNENTERED';
    price_rules: PolicyRule[];
    event_free_limit: { mode: 'UNSET' | 'LIMITED' | 'UNLIMITED'; value: number | null };
    max_party_size: { mode: 'UNSET' | 'LIMITED' | 'UNLIMITED'; value: number | null };
    approval: {
      designated_member_ids: string[]; entrance_regular_approval: boolean;
      self_approval_allowed: boolean;
      renotify_after_seconds: number | null;
      escalate_after_seconds: number | null;
    };
    default_companion_policy: 'PRINCIPAL_ONLY' | 'LIMITED_COMPANIONS';
    customer_match_methods: string[];
    limits_unset_block_publish: boolean;
  };
}
export async function publishedPolicy(c: Client, g: Guc, eventId: string): Promise<Policy | null> {
  const r = await c.query(
    `SELECT id, version, settings FROM nightclub.policy_versions
      WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND status='PUBLISHED'
      ORDER BY version DESC LIMIT 1`,
    [g.tenantId, g.storeId, eventId]);
  return r.rows[0] ?? null;
}

// ---- quota ----
// Bucket keys: 'event_free' (EVENT_HARD), 'actor:<membership>' (ACTOR_BYPASS),
// 'customer:<customer>' (CUSTOMER), 'manual' (MANUAL_DECIDER).
export async function holdQuota(
  c: Client, g: Guc, args: {
    eventId: string; segmentId: string;
    buckets: { key: string; kind: string; limitMode: 'LIMITED' | 'UNLIMITED'; limit: number | null }[];
    count: number;
  },
) {
  for (const b of args.buckets) {
    const bk = await c.query(
      `INSERT INTO nightclub.quota_buckets
         (tenant_id, store_id, event_id, bucket_key, bucket_kind, limit_mode, limit_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, store_id, event_id, bucket_key)
       DO UPDATE SET bucket_key = EXCLUDED.bucket_key
       RETURNING id, limit_mode, limit_count, held_count, consumed_count`,
      // CHECK: LIMITED requires a non-null limit; a missing LIMITED bucket
      // means zero capacity, which the guard below then enforces.
      [g.tenantId, g.storeId, args.eventId, b.key, b.kind, b.limitMode,
       b.limitMode === 'LIMITED' ? (b.limit ?? 0) : null]);
    const bucket = bk.rows[0];
    if (bucket.limit_mode === 'LIMITED'
        && bucket.held_count + bucket.consumed_count + args.count > bucket.limit_count) {
      throw b.kind === 'EVENT_HARD' ? E.hardLimit() : E.quotaExceeded();
    }
    await c.query(
      `UPDATE nightclub.quota_buckets SET held_count = held_count + $4,
          version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id=$1 AND tenant_id=$2 AND store_id=$3`,
      [bucket.id, g.tenantId, g.storeId, args.count]);
    await c.query(
      `INSERT INTO nightclub.quota_allocations
         (tenant_id, store_id, event_id, bucket_id, segment_id, held_count)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, store_id, event_id, bucket_id, segment_id)
       DO UPDATE SET held_count = quota_allocations.held_count + EXCLUDED.held_count`,
      [g.tenantId, g.storeId, args.eventId, bucket.id, args.segmentId, args.count]);
  }
}

export const newTrace = () => uuid();
