// Entrance sync: consistent snapshot + cursor, change feed (outbox-sourced,
// permission-filtered), device ACK, and an SSE stream that only notifies —
// clients always pull data through the changes API.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { withCtx, type Guc } from '../lib/db.js';
import { E } from '../lib/errors.js';
import { signSnapshot, verifySnapshot, sha256 } from '../lib/crypto.js';
import { visitSummary } from '../lib/summary.js';
import {
  body, cursor, eventParams, query, str,
} from '../lib/schemas.js';
import {
  requirePersonal, requireOperator, requirePerm, gucPersonal, gucOperator,
} from '../lib/ctx.js';

interface SyncCaller { g: Guc; memberId: string; operatorSessionId?: string; deviceId?: string }

async function syncCaller(req: FastifyRequest, storeId: string, eventId: string): Promise<SyncCaller> {
  const op = await req.auth.operator().catch((e) => {
    if ((e as { code?: string }).code === 'OPERATOR_CHANGED') throw e;
    return null;
  });
  if (op) {
    if (op.storeId !== storeId || op.eventId !== eventId) throw E.forbidden('wrong store/event');
    const { member } = await requireOperator(req);
    requirePerm(member, 'sync.read');
    return { g: gucOperator(op), memberId: member.membershipId, operatorSessionId: op.sessionId, deviceId: op.deviceId };
  }
  const { member, personal } = await requirePersonal(req, storeId);
  requirePerm(member, 'sync.read');
  return { g: gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId), memberId: member.membershipId };
}

export default async function syncRoutes(app: FastifyInstance) {
  // Consistent snapshot: cursor + full visit list from one repeatable-read tx.
  app.get('/stores/:storeId/events/:eventId/snapshot', {
    schema: { params: eventParams },
  }, async (req) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const caller = await syncCaller(req, storeId, eventId);
    return withCtx(caller.g, async (c) => {
      const head = await c.query(
        `SELECT COALESCE(last_seq,0)::bigint AS seq FROM nightclub.event_stream_heads
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3`,
        [caller.g.tenantId, storeId, eventId]);
      const cursor = String(head.rows[0]?.seq ?? 0);
      const vs = await c.query(
        `SELECT id FROM nightclub.visits
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3
          ORDER BY created_at, id`,
        [caller.g.tenantId, storeId, eventId]);
      const visits = [];
      for (const r of vs.rows) {
        visits.push(await visitSummary(c, caller.g, r.id, eventId));
      }
      const expires = new Date(Date.now() + config.ttl.snapshotSec * 1000);
      return {
        snapshot_token: signSnapshot(eventId, cursor, expires),
        cursor, expires_at: expires, visits,
        has_more: false, next_page_token: null,
      };
    }, { isolation: 'REPEATABLE READ' });
  });

  // Change feed: permission-filtered projection of outbox events.
  app.get('/stores/:storeId/events/:eventId/changes', {
    schema: {
      params: eventParams,
      querystring: query({ cursor, limit: { type: 'string', pattern: '^[0-9]+$', maxLength: 6 } }),
    },
  }, async (req) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const q = req.query as { cursor?: string; limit?: string };
    const caller = await syncCaller(req, storeId, eventId);
    const cursor = BigInt(q.cursor ?? '0');
    const limit = Math.min(Number(q.limit) || config.changes.pageLimit, config.changes.pageLimit);
    return withCtx(caller.g, async (c) => {
      const r = await c.query(
        `SELECT stream_seq, event_type, aggregate_type, aggregate_id,
                aggregate_version, payload
           FROM nightclub.outbox_events
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND stream_seq > $4
          ORDER BY stream_seq LIMIT $5`,
        [caller.g.tenantId, storeId, eventId, cursor.toString(), limit + 1]);
      const items = [];
      for (const row of r.rows.slice(0, limit)) {
        // Project to permission-shaped data; never forward raw outbox payload.
        let data: unknown = null;
        if (row.aggregate_type === 'visit') {
          data = { visit: await visitSummary(c, caller.g, row.aggregate_id, eventId) };
        } else {
          data = { type: row.event_type, aggregate_id: row.aggregate_id };
        }
        items.push({
          event_id: eventId,
          stream_seq: Number(row.stream_seq),
          event_type: row.event_type,
          aggregate_type: row.aggregate_type,
          aggregate_id: row.aggregate_id,
          aggregate_version: row.aggregate_version,
          action: 'UPSERT',
          data,
        });
      }
      return {
        items,
        has_more: r.rows.length > limit,
        next_cursor: r.rows.length ? String(r.rows[Math.min(r.rows.length, limit) - 1].stream_seq) : String(cursor),
      };
    });
  });

  // Device ACK: proves data applied to screen (not human read).
  app.post('/stores/:storeId/events/:eventId/sync-ack', {
    schema: {
      params: eventParams,
      body: body({
        snapshot_token: str(2000), cursor,
        visibility: { type: 'string', enum: ['FOREGROUND', 'BACKGROUND'] },
      }, ['snapshot_token', 'cursor', 'visibility']),
    },
  }, async (req) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const { operator, member } = await requireOperator(req);
    if (operator.storeId !== storeId || operator.eventId !== eventId) {
      throw E.forbidden('wrong store/event');
    }
    requirePerm(member, 'sync.ack');
    const b = req.body as { snapshot_token?: string; cursor?: string; visibility?: string };
    if (!b?.snapshot_token || b.cursor == null || !b.visibility) {
      throw E.invalid('snapshot_token, cursor, visibility required');
    }
    const snapshotToken = b.snapshot_token;
    const visibility = b.visibility;
    const snap = verifySnapshot(snapshotToken, eventId);
    if (!snap) throw E.snapshotRequired();
    return withCtx(gucOperator(operator), async (c) => {
      const head = await c.query(
        `SELECT COALESCE(last_seq,0)::bigint AS seq FROM nightclub.event_stream_heads
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3`,
        [operator.tenantId, storeId, eventId]);
      const headSeq = BigInt(String(head.rows[0]?.seq ?? 0));
      const cur = BigInt(b.cursor!);
      if (cur > headSeq) throw E.invalid('cursor beyond head');
      await c.query(
        `INSERT INTO nightclub.sync_acks
           (tenant_id, store_id, event_id, device_id, operator_session_id,
            applied_seq, snapshot_token_hash, last_seen_at, visibility)
         VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP,$8)
         ON CONFLICT (tenant_id, store_id, event_id, device_id)
         DO UPDATE SET applied_seq=EXCLUDED.applied_seq,
           operator_session_id=EXCLUDED.operator_session_id,
           snapshot_token_hash=EXCLUDED.snapshot_token_hash,
           last_seen_at=CURRENT_TIMESTAMP, visibility=EXCLUDED.visibility,
           version=sync_acks.version+1, updated_at=CURRENT_TIMESTAMP`,
        [operator.tenantId, storeId, eventId, operator.deviceId,
         operator.sessionId, cur.toString(), sha256(snapshotToken), visibility]);
      return { accepted: true, trace_id: req.traceId };
    });
  });

  // SSE notify stream: sends "changed" pings with the latest cursor only.
  app.get('/stores/:storeId/events/:eventId/stream', {
    schema: { params: eventParams, querystring: query({ cursor }) },
  }, async (req, reply) => {
    const { storeId, eventId } = req.params as { storeId: string; eventId: string; visitId: string; requestId: string; entryId: string; orderId: string; paymentId: string; refundId: string; bookingId: string; settlementId: string; permitId: string; policyId: string; customerId: string; membershipId: string; deviceId: string; roleId: string };
    const caller = await syncCaller(req, storeId, eventId);
    // Resume cursor: Last-Event-ID (SSE reconnect) takes precedence over the
    // explicit ?cursor= query param.
    const lastId = req.headers['last-event-id'];
    const q = (req.query as { cursor?: string }).cursor;
    let cursor = BigInt(
      typeof lastId === 'string' && /^\d+$/.test(lastId) ? lastId : (q ?? '0'));
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(`event: ready\ndata: {"cursor":"${cursor}"}\n\n`);
    let closed = false;
    req.raw.on('close', () => { closed = true; });
    const g = caller.g;
    while (!closed) {
      try {
        const head = await withCtx(g, async (c) => {
          const r = await c.query(
            `SELECT COALESCE(last_seq,0)::bigint AS seq FROM nightclub.event_stream_heads
              WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3`,
            [g.tenantId, g.storeId, eventId]);
          return BigInt(String(r.rows[0]?.seq ?? 0));
        });
        if (head > cursor) {
          cursor = head;
          // id: lets the browser supply Last-Event-ID on reconnect.
          reply.raw.write(`id: ${cursor}\nevent: changed\ndata: {"cursor":"${cursor}"}\n\n`);
        } else {
          reply.raw.write(`event: ping\ndata: {}\n\n`);
        }
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, config.changes.pollMs));
    }
    reply.raw.end();
  });
}
