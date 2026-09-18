// Aggregate -> contract summary shaping, shared by routes and sync payloads.
import type { Client, Guc } from './db.js';

export async function visitSummary(c: Client, g: Guc, visitId: string, eventId: string) {
  const v = await c.query(
    `SELECT v.id, v.version, v.reception_name, v.customer_id,
            v.referrer_membership_id, v.arrival_status, v.status, v.name_key,
            m.display_name AS referrer_name
       FROM nightclub.visits v
       LEFT JOIN nightclub.memberships m
         ON m.tenant_id=v.tenant_id AND m.store_id=v.store_id
        AND m.id=v.referrer_membership_id
      WHERE v.tenant_id=$1 AND v.store_id=$2 AND v.event_id=$3 AND v.id=$4`,
    [g.tenantId, g.storeId, eventId, visitId]);
  if (!v.rows[0]) return null;
  const seg = await c.query(
    `SELECT s.id, s.version, s.status, s.requested_count, s.authorized_count,
            s.first_entered_count, s.unit_amount_minor, s.currency,
            s.authorization_method, s.entry_until, s.required_customer_id,
            s.price_rule_id, s.permit_id, s.snapshot
       FROM nightclub.admission_segments s
      WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.event_id=$3 AND s.visit_id=$4
      ORDER BY s.created_at`,
    [g.tenantId, g.storeId, eventId, visitId]);
  const sync = await c.query(
    `SELECT
       (SELECT count(*)::int FROM nightclub.device_sessions ds
          WHERE ds.tenant_id=$1 AND ds.store_id=$2 AND ds.revoked_at IS NULL
            AND ds.expires_at > CURRENT_TIMESTAMP) AS active_devices,
       (SELECT count(*)::int FROM nightclub.sync_acks sa
          WHERE sa.tenant_id=$1 AND sa.store_id=$2 AND sa.event_id=$3) AS synced_devices`,
    [g.tenantId, g.storeId, eventId]);
  const pass = await c.query(
    `SELECT id, presence FROM nightclub.entry_passes
      WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND visit_id=$4
        AND pass_kind='GROUP_LOOKUP' AND revoked_at IS NULL
        AND expires_at > CURRENT_TIMESTAMP
      ORDER BY created_at DESC LIMIT 1`,
    [g.tenantId, g.storeId, eventId, visitId]);
  const segments = seg.rows.map((s) => ({
    id: s.id, version: s.version, status: s.status,
    requested_count: s.requested_count, authorized_count: s.authorized_count,
    first_entered_count: s.first_entered_count,
    remaining_count: Math.max(0, s.authorized_count - s.first_entered_count),
    unit_amount_minor: Number(s.unit_amount_minor), currency: s.currency,
    authorization_method: s.authorization_method,
    requires_identity_check:
      !!s.required_customer_id ||
      (s.snapshot as { requires_identity_check?: boolean })?.requires_identity_check === true,
    entry_until: s.entry_until,
    rule_key: (s.snapshot as { rule_key?: string })?.rule_key ?? null,
  }));
  return {
    id: v.rows[0].id, version: v.rows[0].version,
    reception_name: v.rows[0].reception_name,
    customer_id: v.rows[0].customer_id,
    referrer_membership_id: v.rows[0].referrer_membership_id,
    referrer_name: v.rows[0].referrer_name,
    arrival_status: v.rows[0].arrival_status,
    status: v.rows[0].status,
    pass_id: pass.rows[0]?.id ?? null,
    pass_presence: pass.rows[0]?.presence ?? null,
    segments,
    entry_device_sync: {
      active_devices: sync.rows[0].active_devices,
      synced_devices: sync.rows[0].synced_devices,
    },
  };
}
