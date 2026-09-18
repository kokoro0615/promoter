-- 0005: v5 endpoint-completion schema deltas.
-- 1) events.status gains 'CANCELED' (explicit cancel command vs operational
--    CLOSED). CANCELED matches no open-state checks, so reads treat it as
--    inert; the distinction matters for reporting (canceled before open vs
--    ran and closed).

ALTER TABLE nightclub.events DROP CONSTRAINT events_status_check;
ALTER TABLE nightclub.events ADD CONSTRAINT events_status_check
  CHECK (status IN ('DRAFT','PUBLISHED','OPEN','RECONCILING','CLOSED','CANCELED'));

-- 2) Platform operators manage stores across tenants under scope='system'.
--    Previously WITH CHECK required tenant_id = ctx_tenant(), which is unset in
--    system scope -> every platform store insert was an RLS violation. Personal
--    scope stays tenant-bound; only system scope is widened (same shape as
--    nc_tenants).
DROP POLICY nc_stores ON nightclub.stores;
CREATE POLICY nc_stores ON nightclub.stores FOR ALL TO app_runtime, app_readonly
  USING (
    tenant_id = nightclub.ctx_tenant()
    OR id IN (SELECT m.store_id FROM nightclub.memberships m WHERE m.user_id = nightclub.ctx_user())
    OR nightclub.ctx_scope() = 'system'
  )
  WITH CHECK (
    nightclub.ctx_scope() = 'system'
    OR (tenant_id = nightclub.ctx_tenant() AND nightclub.ctx_scope() = 'personal')
  );

-- 3) app_runtime deliberately lacks DELETE by default (append-only ledgers).
--    The tables below are current-state join/config rows where the API
--    implements set-replacement/removal semantics; audit_events captures the
--    change history, so targeted DELETE grants are safe.
GRANT DELETE ON
  nightclub.membership_roles, nightclub.role_permissions,
  nightclub.event_assignments, nightclub.price_rules,
  nightclub.customer_tag_assignments, nightclub.visit_members,
  nightclub.platform_operators,
  nightclub.command_receipts, nightclub.platform_command_receipts
  TO app_runtime;
