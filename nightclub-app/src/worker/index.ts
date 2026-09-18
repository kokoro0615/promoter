// Worker: outbox publish + notification fan-out + expiry sweeps.
// Runs as app_runtime under 'system' scope. Idempotent: outbox rows carry
// stream_seq; notification jobs dedupe on dedup_key; sweeps only move
// expired rows once (status transition).
import { pool, withCtx, withSystem } from '../server/lib/db.js';

const POLL_MS = Number(process.env.WORKER_POLL_MS || 1500);

async function publishOutbox(): Promise<number> {
  return withSystem(async (c) => {
    const claimed = await c.query(
      'SELECT * FROM nightclub.outbox_claim(200)');
    const rows = claimed.rows;
    if (!rows.length) return 0;
    // Fan-out: approval requests notify designated approvers + entrance
    // approvers (IN_APP in dev; real channels are provider-gated).
    for (const r of rows) {
      if (r.event_type !== 'visit.upserted') continue;
      const visit = (r.payload as { visit?: { segments?: { status: string }[]; id?: string } })
        .visit;
      if (!visit?.segments?.some((s) => s.status === 'PENDING')) continue;
      const approvers = await c.query(
        `SELECT DISTINCT ea.membership_id FROM nightclub.event_assignments ea
          WHERE ea.tenant_id=$1 AND ea.store_id=$2 AND ea.event_id=$3
            AND ea.assignment_kind IN ('DESIGNATED_APPROVER','ENTRANCE_APPROVER')
            AND ea.starts_at <= CURRENT_TIMESTAMP AND ea.ends_at > CURRENT_TIMESTAMP`,
        [r.tenant_id, r.store_id, r.event_id]);
      for (const a of approvers.rows) {
        await c.query(
          `INSERT INTO nightclub.notification_jobs
             (tenant_id, store_id, event_id, outbox_event_id,
              recipient_membership_id, channel, dedup_key, scheduled_at)
           VALUES ($1,$2,$3,$4,$5,'IN_APP',$6,CURRENT_TIMESTAMP)
           ON CONFLICT (tenant_id, store_id, dedup_key) DO NOTHING`,
          [r.tenant_id, r.store_id, r.event_id, r.id, a.membership_id,
           `approval:${visit.id}:${a.membership_id}`]);
      }
    }
    await c.query(
      'SELECT nightclub.outbox_mark_published($1::uuid[])',
      [rows.map((r) => r.id)]);
    return rows.length;
  });
}

async function sendNotifications(): Promise<number> {
  // Dev adapter: IN_APP notifications are "sent" by marking; external
  // channels (LINE/PUSH/EMAIL) require provider credentials -> stay QUEUED.
  return withSystem(async (c) => {
    const r = await c.query(
      `UPDATE nightclub.notification_jobs
          SET status='SENT', attempts=attempts+1, version=version+1,
              updated_at=CURRENT_TIMESTAMP
        WHERE channel='IN_APP' AND status='QUEUED'
          AND scheduled_at <= CURRENT_TIMESTAMP
        RETURNING id`);
    return r.rowCount ?? 0;
  });
}

async function expirySweep(): Promise<number> {
  // Segments past entry_until that never entered release their holds.
  return withSystem(async (c) => {
    const segs = await c.query(
      `SELECT s.id, s.tenant_id, s.store_id, s.event_id, s.authorized_count,
              s.first_entered_count
         FROM nightclub.admission_segments s
        WHERE s.status='AUTHORIZED' AND s.entry_until <= CURRENT_TIMESTAMP
          AND s.first_entered_count < s.authorized_count
        FOR UPDATE OF s SKIP LOCKED LIMIT 100`);
    let n = 0;
    for (const s of segs.rows) {
      const unentered = s.authorized_count - s.first_entered_count;
      const allocs = await c.query(
        `SELECT id, bucket_id, held_count FROM nightclub.quota_allocations
          WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND segment_id=$4
          FOR UPDATE`, [s.tenant_id, s.store_id, s.event_id, s.id]);
      let left = unentered;
      for (const a of allocs.rows) {
        const take = Math.min(a.held_count, left);
        if (take <= 0) continue;
        await c.query(
          `UPDATE nightclub.quota_allocations
              SET held_count=held_count-$4, version=version+1,
                  updated_at=CURRENT_TIMESTAMP
            WHERE id=$1 AND tenant_id=$2 AND store_id=$3`,
          [a.id, s.tenant_id, s.store_id, take]);
        await c.query(
          `UPDATE nightclub.quota_buckets
              SET held_count=held_count-$4, version=version+1,
                  updated_at=CURRENT_TIMESTAMP
            WHERE id=$1 AND tenant_id=$2 AND store_id=$3`,
          [a.bucket_id, s.tenant_id, s.store_id, take]);
        left -= take;
      }
      await c.query(
        `UPDATE nightclub.admission_segments
            SET status='EXPIRED', version=version+1, updated_at=CURRENT_TIMESTAMP
          WHERE id=$1 AND tenant_id=$2 AND store_id=$3`,
        [s.id, s.tenant_id, s.store_id]);
      n += 1;
    }
    return n;
  });
}

// EP25: export_jobs executor. Writes CSV under EXPORT_DIR, marks READY with a
// 24h download expiry. Runs tenant/store-scoped so RLS applies normally.
async function runExports(): Promise<number> {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const jobs = await withSystem(async (c) => (await c.query(
    `SELECT id, tenant_id, store_id, report_kind, filters
       FROM nightclub.export_jobs
      WHERE status='QUEUED' ORDER BY created_at LIMIT 10
      FOR UPDATE SKIP LOCKED`)).rows);
  let n = 0;
  for (const j of jobs) {
    try {
      const g = { scope: 'system' as const, tenantId: j.tenant_id, storeId: j.store_id };
      const csv = await withCtx(g, async (c) => {
        const esc = (v: unknown) => {
          const s = v == null ? '' : String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const toCsv = (cols: string[], rows: Record<string, unknown>[]) =>
          [cols.join(','), ...rows.map((r) => cols.map((k) => esc(r[k])).join(','))].join('\n') + '\n';
        if (j.report_kind === 'visits') {
          const r = await c.query(
            `SELECT v.id, v.reception_name, v.status, v.arrival_status,
                    v.planned_count, e.name AS event, v.created_at
               FROM nightclub.visits v JOIN nightclub.events e
                 ON e.tenant_id=v.tenant_id AND e.store_id=v.store_id AND e.id=v.event_id
              WHERE v.tenant_id=$1 AND v.store_id=$2 ORDER BY v.created_at`,
            [j.tenant_id, j.store_id]);
          return toCsv(['id', 'reception_name', 'status', 'arrival_status', 'planned_count', 'event', 'created_at'], r.rows);
        }
        if (j.report_kind === 'payments') {
          const r = await c.query(
            `SELECT p.id, p.method, p.purpose, p.amount_minor, p.currency,
                    p.status, e.name AS event, p.created_at
               FROM nightclub.payments p JOIN nightclub.events e
                 ON e.tenant_id=p.tenant_id AND e.store_id=p.store_id AND e.id=p.event_id
              WHERE p.tenant_id=$1 AND p.store_id=$2 ORDER BY p.created_at`,
            [j.tenant_id, j.store_id]);
          return toCsv(['id', 'method', 'purpose', 'amount_minor', 'currency', 'status', 'event', 'created_at'], r.rows);
        }
        const r = await c.query(
          `SELECT id, action, target_type, target_id, created_at
             FROM nightclub.audit_logs
            WHERE tenant_id=$1 AND store_id=$2 ORDER BY created_at DESC LIMIT 5000`,
          [j.tenant_id, j.store_id]);
        return toCsv(['id', 'action', 'target_type', 'target_id', 'created_at'], r.rows);
      });
      const dir = resolve(process.env.EXPORT_DIR || 'devdb/exports');
      mkdirSync(dir, { recursive: true });
      const key = `${j.id}.csv`;
      writeFileSync(resolve(dir, key), csv);
      await withCtx(g, (c) => c.query(
        `UPDATE nightclub.export_jobs
            SET status='READY', object_key=$4,
                expires_at=CURRENT_TIMESTAMP + interval '24 hours',
                version=version+1, updated_at=CURRENT_TIMESTAMP
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
        [j.tenant_id, j.store_id, j.id, key]));
      n += 1;
    } catch (e) {
      await withSystem((c) => c.query(
        `UPDATE nightclub.export_jobs SET status='FAILED', version=version+1,
            updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [j.id]));
      console.error(`[worker] export ${j.id} failed`, e);
    }
  }
  return n;
}

async function tick() {
  try {
    const [pub, notif, exp, expj] = await Promise.all([
      publishOutbox(), sendNotifications(), expirySweep(), runExports(),
    ]);
    if (pub + notif + exp + expj > 0) {
      console.log(`[worker] outbox=${pub} notifications=${notif} expired=${exp} exports=${expj}`);
    }
  } catch (e) {
    console.error('[worker] tick failed', e);
  }
}

export async function runOnce() { await tick(); }

if (process.env.WORKER_AUTOSTART !== '0') {
  console.log(`[worker] started, poll=${POLL_MS}ms`);
  const timer = setInterval(tick, POLL_MS);
  process.on('SIGTERM', async () => {
    clearInterval(timer);
    await pool.end();
    process.exit(0);
  });
}
