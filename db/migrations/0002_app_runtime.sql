-- 0002_app_runtime.sql
-- Application runtime layer on top of the reference DDL:
--   * pg_trgm extension (substring name search; reference ships prefix indexes only)
--   * runtime/readonly role grants and column-level immutability
--   * session-context GUC helpers (set from verified cookies only, never client ids)
--   * RLS policies: tenant/store boundary + device/operator scoping
--   * SECURITY DEFINER bridge functions for pre-context flows (login, pairing,
--     invitation redeem, PIN load) so those tables stay deny-by-default
--   * updated_at touch trigger on all tables that carry the column
-- Depends on: 0001_reference_base.sql
BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------- roles ----
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_migrator') THEN
    CREATE ROLE app_migrator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_readonly') THEN
    CREATE ROLE app_readonly NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA nightclub TO app_runtime;
GRANT USAGE ON SCHEMA nightclub TO app_readonly;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA nightclub TO app_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA nightclub TO app_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA nightclub
  GRANT SELECT, INSERT, UPDATE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA nightclub
  GRANT SELECT ON TABLES TO app_readonly;

-- Immutability: ledger/audit rows are never rewritten or removed by the runtime
-- role. Corrections are append-only compensating rows.
REVOKE UPDATE ON
  nightclub.audit_logs,
  nightclub.admission_events,
  nightclub.approval_decisions,
  nightclub.booking_decisions,
  nightclub.settlement_lines,
  nightclub.payment_allocations,
  nightclub.reward_adjustments,
  nightclub.sales_lines,
  nightclub.outbox_events
FROM app_runtime;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = 'nc_schema_migrations') THEN
    EXECUTE 'REVOKE ALL ON public.nc_schema_migrations FROM PUBLIC';
  END IF;
END $$;

-- -------------------------------------------------- session context GUCs ----
-- The API sets these per transaction (SET LOCAL) from *verified* session
-- cookies only. Client-supplied tenant/store ids are never copied into GUCs.
CREATE OR REPLACE FUNCTION nightclub.ctx_scope() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.scope', true), '') $$;
CREATE OR REPLACE FUNCTION nightclub.ctx_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION nightclub.ctx_store() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.store_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION nightclub.ctx_user() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION nightclub.ctx_member() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.member_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION nightclub.ctx_device() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.device_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION nightclub.ctx_device_session() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.device_session_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION nightclub.ctx_operator_session() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.operator_session_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION nightclub.ctx_event() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.event_id', true), '')::uuid $$;

-- ------------------------------------------------------------- policies ----
-- Scope legend: 'personal' (member PWA cookie), 'device' (paired kiosk cookie
-- only), 'operator' (kiosk + unlocked operator session), 'system' (worker/jobs).
-- Guest/business data requires personal|operator|system: a device credential
-- alone can never read customer lists (INV: device auth != data auth).

-- global: tenants
CREATE POLICY nc_tenants ON nightclub.tenants FOR ALL TO app_runtime, app_readonly
  USING (
    id = nightclub.ctx_tenant()
    OR id IN (SELECT m.tenant_id FROM nightclub.memberships m WHERE m.user_id = nightclub.ctx_user())
    OR nightclub.ctx_scope() = 'system'
  )
  WITH CHECK (nightclub.ctx_scope() = 'system');

-- global: app_users (insert allowed: invitation redeem creates user pre-session
-- via definer anyway; direct insert permitted for personal/system scope)
CREATE POLICY nc_app_users_sel ON nightclub.app_users FOR SELECT TO app_runtime, app_readonly
  USING (
    id = nightclub.ctx_user()
    OR id IN (SELECT m.user_id FROM nightclub.memberships m
              WHERE m.tenant_id = nightclub.ctx_tenant() AND m.store_id = nightclub.ctx_store())
    OR nightclub.ctx_scope() = 'system'
  );
CREATE POLICY nc_app_users_ins ON nightclub.app_users FOR INSERT TO app_runtime
  WITH CHECK (nightclub.ctx_scope() IN ('personal', 'system'));
CREATE POLICY nc_app_users_upd ON nightclub.app_users FOR UPDATE TO app_runtime
  USING (id = nightclub.ctx_user() OR nightclub.ctx_scope() = 'system')
  WITH CHECK (id = nightclub.ctx_user() OR nightclub.ctx_scope() = 'system');

-- external_identities / auth_sessions / operator_credentials: no runtime
-- policies -> deny-all. Access only through SECURITY DEFINER bridges below.

-- stores (tenant-scoped)
CREATE POLICY nc_stores ON nightclub.stores FOR ALL TO app_runtime, app_readonly
  USING (
    tenant_id = nightclub.ctx_tenant()
    OR id IN (SELECT m.store_id FROM nightclub.memberships m WHERE m.user_id = nightclub.ctx_user())
    OR nightclub.ctx_scope() = 'system'
  )
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND nightclub.ctx_scope() IN ('personal', 'system'));

-- memberships: store members visible to any established context; own rows
-- visible across stores for session bootstrap (scope=personal w/o store yet).
CREATE POLICY nc_memberships ON nightclub.memberships FOR ALL TO app_runtime, app_readonly
  USING (
    (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
      AND nightclub.ctx_scope() IN ('personal', 'device', 'operator', 'system'))
    OR user_id = nightclub.ctx_user()
  )
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'system'));

CREATE POLICY nc_roles ON nightclub.roles FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'device', 'operator', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'system'));

CREATE POLICY nc_role_permissions ON nightclub.role_permissions FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'device', 'operator', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'system'));

CREATE POLICY nc_membership_roles ON nightclub.membership_roles FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'device', 'operator', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'system'));

CREATE POLICY nc_invitation_tokens ON nightclub.invitation_tokens FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'system'));

-- events: store-scoped, readable by device scope (kiosk picks the event).
CREATE POLICY nc_events ON nightclub.events FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'device', 'operator', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'system'));

-- devices / device_sessions: device scope limited to its own row.
CREATE POLICY nc_devices ON nightclub.devices FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND (nightclub.ctx_scope() IN ('personal', 'system')
              OR (nightclub.ctx_scope() IN ('device', 'operator') AND id = nightclub.ctx_device())))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND (nightclub.ctx_scope() IN ('personal', 'system')
                   OR (nightclub.ctx_scope() IN ('device', 'operator') AND id = nightclub.ctx_device())));

CREATE POLICY nc_device_sessions ON nightclub.device_sessions FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND (nightclub.ctx_scope() IN ('personal', 'system')
              OR (nightclub.ctx_scope() IN ('device', 'operator')
                  AND device_id = nightclub.ctx_device())))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() = 'system');

-- device_enrollments: deny direct runtime access (definer bridge only).
CREATE POLICY nc_device_enrollments ON nightclub.device_enrollments FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'system'));

-- operator_sessions: device sees its own sessions (unlock/replace flow);
-- operator sees own device sessions; personal sees store-wide (admin view).
CREATE POLICY nc_operator_sessions ON nightclub.operator_sessions FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND (nightclub.ctx_scope() IN ('personal', 'system')
              OR (nightclub.ctx_scope() IN ('device', 'operator')
                  AND device_id = nightclub.ctx_device())))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND (nightclub.ctx_scope() IN ('personal', 'system')
                   OR (nightclub.ctx_scope() = 'device'
                       AND device_id = nightclub.ctx_device()
                       AND event_id = nightclub.ctx_event())));

-- store-scoped business data: personal|operator|system only.
CREATE POLICY nc_customers ON nightclub.customers FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'));
CREATE POLICY nc_customer_aliases ON nightclub.customer_aliases FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'));
CREATE POLICY nc_operating_templates ON nightclub.operating_templates FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'system'));
CREATE POLICY nc_permits ON nightclub.permits FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'));
CREATE POLICY nc_referrer_profiles ON nightclub.referrer_profiles FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'system'));
CREATE POLICY nc_coupons ON nightclub.coupons FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'system'));
CREATE POLICY nc_floor_maps ON nightclub.floor_maps FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'system'));
CREATE POLICY nc_venue_tables ON nightclub.venue_tables FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'system'));
CREATE POLICY nc_reward_rules ON nightclub.reward_rules FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'system'));
CREATE POLICY nc_command_receipts ON nightclub.command_receipts FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'));
CREATE POLICY nc_notification_templates ON nightclub.notification_templates FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'system'));
CREATE POLICY nc_integration_events ON nightclub.integration_events FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'system'));
CREATE POLICY nc_audit_logs_sel ON nightclub.audit_logs FOR SELECT TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'));
CREATE POLICY nc_audit_logs_ins ON nightclub.audit_logs FOR INSERT TO app_runtime
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'));
-- export_jobs: tenant-scoped for users; the export worker scans QUEUED jobs
-- across tenants under bare system scope, so system also sees all rows.
CREATE POLICY nc_export_jobs ON nightclub.export_jobs FOR ALL TO app_runtime, app_readonly
  USING ((tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
          AND nightclub.ctx_scope() IN ('personal', 'system'))
         OR nightclub.ctx_scope() = 'system')
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'system'));
CREATE POLICY nc_import_jobs ON nightclub.import_jobs FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'system'));

-- event-scoped tables: personal -> any event in store; operator -> only the
-- event bound to its session; device -> denied (no guest data pre-unlock).
DO $$
DECLARE
  t text;
  event_tables text[] := ARRAY[
    'event_assignments', 'policy_versions', 'price_rules', 'invitation_links',
    'visits', 'visit_members', 'customer_checks', 'admission_segments',
    'approval_requests', 'approval_decisions', 'quota_buckets',
    'quota_allocations', 'entry_passes', 'admission_events',
    'provisional_entries', 'bookings', 'booking_decisions',
    'table_allocations', 'sales_orders', 'sales_lines', 'payments',
    'payment_allocations', 'refunds', 'payment_disputes',
    'coupon_redemptions', 'sales_attributions', 'settlements',
    'settlement_lines', 'reward_adjustments', 'reward_disputes',
    'settlement_payments', 'cash_sessions', 'event_stream_heads',
    'outbox_events', 'sync_acks', 'notification_jobs'
  ];
BEGIN
  FOREACH t IN ARRAY event_tables LOOP
    EXECUTE format(
      'CREATE POLICY nc_%I ON nightclub.%I FOR ALL TO app_runtime, app_readonly
         USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
                AND (nightclub.ctx_scope() IN (''personal'', ''system'')
                     OR (nightclub.ctx_scope() = ''operator''
                         AND event_id = nightclub.ctx_event())))
         WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
                AND (nightclub.ctx_scope() IN (''personal'', ''system'')
                     OR (nightclub.ctx_scope() = ''operator''
                         AND event_id = nightclub.ctx_event())))',
      replace(t, '_', ''), t);
  END LOOP;

  -- device scope may read event_assignments for the event being unlocked
  -- (assignment validation during operator unlock).
  EXECUTE 'CREATE POLICY nc_eventassign_device ON nightclub.event_assignments FOR SELECT
             TO app_runtime
             USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
                    AND nightclub.ctx_scope() = ''device''
                    AND event_id = nightclub.ctx_event())';
END $$;

-- ------------------------------------------- SECURITY DEFINER bridges ------
-- Pre-context flows. All owned by the migrator (bypass RLS), pinned search_path,
-- EXECUTE revoked from PUBLIC and granted to app_runtime only.

CREATE OR REPLACE FUNCTION nightclub.auth_find_identity(
  p_issuer text, p_client_id text, p_subject text
) RETURNS TABLE(user_id uuid, user_status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nightclub, public AS $$
  SELECT u.id, u.status FROM nightclub.external_identities ei
  JOIN nightclub.app_users u ON u.id = ei.user_id
  WHERE ei.issuer = p_issuer AND ei.client_id = p_client_id AND ei.subject = p_subject
$$;

CREATE OR REPLACE FUNCTION nightclub.auth_create_user(
  p_display_name text, p_issuer text, p_client_id text, p_subject text
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = nightclub, public AS $$
DECLARE v_user uuid;
BEGIN
  INSERT INTO nightclub.app_users (display_name) VALUES (p_display_name) RETURNING id INTO v_user;
  INSERT INTO nightclub.external_identities (user_id, issuer, client_id, subject)
    VALUES (v_user, p_issuer, p_client_id, p_subject);
  RETURN v_user;
END $$;

CREATE OR REPLACE FUNCTION nightclub.auth_create_session(
  p_user_id uuid, p_token_hash text, p_expires_at timestamptz
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = nightclub, public AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO nightclub.auth_sessions (user_id, token_hash, expires_at)
    VALUES (p_user_id, p_token_hash, p_expires_at) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION nightclub.auth_resolve_session(p_token_hash text)
  RETURNS TABLE(session_id uuid, user_id uuid, user_status text,
                expires_at timestamptz, revoked_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nightclub, public AS $$
  SELECT s.id, s.user_id, u.status, s.expires_at, s.revoked_at
  FROM nightclub.auth_sessions s JOIN nightclub.app_users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash
$$;

CREATE OR REPLACE FUNCTION nightclub.auth_revoke_session(p_session_id uuid)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = nightclub, public AS $$
  UPDATE nightclub.auth_sessions SET revoked_at = CURRENT_TIMESTAMP,
    version = version + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = p_session_id AND revoked_at IS NULL
$$;

CREATE OR REPLACE FUNCTION nightclub.invitation_lookup(p_token_hash text)
  RETURNS TABLE(tenant_id uuid, store_id uuid, store_name text, role_name text,
                invite_target text, expires_at timestamptz, used_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nightclub, public AS $$
  SELECT t.tenant_id, t.store_id, s.name, r.name, t.invite_target, t.expires_at, t.used_at
  FROM nightclub.invitation_tokens t
  JOIN nightclub.stores s ON s.tenant_id = t.tenant_id AND s.id = t.store_id
  LEFT JOIN nightclub.roles r ON r.tenant_id = t.tenant_id AND r.store_id = t.store_id
                             AND r.id = t.role_id
  WHERE t.token_hash = p_token_hash
$$;

CREATE OR REPLACE FUNCTION nightclub.invitation_redeem(
  p_token_hash text, p_display_name text,
  p_issuer text, p_client_id text, p_subject text
) RETURNS TABLE(user_id uuid, membership_id uuid, tenant_id uuid, store_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = nightclub, public AS $$
DECLARE
  v_tok nightclub.invitation_tokens%ROWTYPE;
  v_user uuid; v_member uuid;
BEGIN
  SELECT * INTO v_tok FROM nightclub.invitation_tokens
    WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVITE_INVALID'; END IF;
  IF v_tok.used_at IS NOT NULL THEN RAISE EXCEPTION 'INVITE_USED'; END IF;
  IF v_tok.expires_at <= CURRENT_TIMESTAMP THEN RAISE EXCEPTION 'INVITE_EXPIRED'; END IF;

  SELECT ei.user_id INTO v_user FROM nightclub.external_identities ei
    WHERE ei.issuer = p_issuer AND ei.client_id = p_client_id AND ei.subject = p_subject;
  IF v_user IS NULL THEN
    INSERT INTO nightclub.app_users (display_name) VALUES (p_display_name)
      RETURNING id INTO v_user;
    INSERT INTO nightclub.external_identities (user_id, issuer, client_id, subject)
      VALUES (v_user, p_issuer, p_client_id, p_subject);
  END IF;

  INSERT INTO nightclub.memberships (tenant_id, store_id, user_id, display_name)
    VALUES (v_tok.tenant_id, v_tok.store_id, v_user, p_display_name)
    ON CONFLICT (tenant_id, store_id, user_id)
    DO UPDATE SET status = 'ACTIVE', valid_to = NULL, version = memberships.version + 1,
                  updated_at = CURRENT_TIMESTAMP
    RETURNING id INTO v_member;
  IF v_tok.role_id IS NOT NULL THEN
    INSERT INTO nightclub.membership_roles
        (tenant_id, store_id, membership_id, role_id, granted_by)
      SELECT v_tok.tenant_id, v_tok.store_id, v_member, v_tok.role_id, v_tok.issued_by
      ON CONFLICT (tenant_id, store_id, membership_id, role_id) DO NOTHING;
  END IF;
  UPDATE nightclub.invitation_tokens
    SET used_at = CURRENT_TIMESTAMP, used_by = v_user,
        version = version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = v_tok.id;
  RETURN QUERY SELECT v_user, v_member, v_tok.tenant_id, v_tok.store_id;
END $$;

-- device pairing: one-time enrollment code -> device session, atomically.
CREATE OR REPLACE FUNCTION nightclub.device_consume_enrollment(
  p_code_hash text, p_token_hash text, p_expires_at timestamptz
) RETURNS TABLE(device_session_id uuid, device_id uuid, tenant_id uuid,
                store_id uuid, operator_epoch bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = nightclub, public AS $$
DECLARE
  v_en nightclub.device_enrollments%ROWTYPE;
  v_dev nightclub.devices%ROWTYPE;
  v_sess uuid;
BEGIN
  SELECT * INTO v_en FROM nightclub.device_enrollments
    WHERE code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ENROLL_INVALID'; END IF;
  IF v_en.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'ENROLL_USED'; END IF;
  IF v_en.expires_at <= CURRENT_TIMESTAMP THEN RAISE EXCEPTION 'ENROLL_EXPIRED'; END IF;
  SELECT * INTO v_dev FROM nightclub.devices d
    WHERE d.tenant_id = v_en.tenant_id AND d.store_id = v_en.store_id
      AND d.id = v_en.device_id FOR UPDATE;
  IF v_dev.status <> 'PENDING' OR v_dev.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'DEVICE_REVOKED';
  END IF;
  UPDATE nightclub.devices SET status = 'ACTIVE',
    version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = v_dev.id;
  UPDATE nightclub.device_enrollments SET consumed_at = CURRENT_TIMESTAMP,
    version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = v_en.id;
  INSERT INTO nightclub.device_sessions
      (tenant_id, store_id, device_id, token_hash, expires_at)
    VALUES (v_en.tenant_id, v_en.store_id, v_en.device_id, p_token_hash, p_expires_at)
    RETURNING id INTO v_sess;
  RETURN QUERY SELECT v_sess, v_dev.id, v_en.tenant_id, v_en.store_id,
                      v_dev.operator_epoch;
END $$;

CREATE OR REPLACE FUNCTION nightclub.device_resolve_session(p_token_hash text)
  RETURNS TABLE(session_id uuid, device_id uuid, tenant_id uuid, store_id uuid,
                device_status text, operator_epoch bigint,
                expires_at timestamptz, revoked_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nightclub, public AS $$
  SELECT s.id, s.device_id, s.tenant_id, s.store_id, d.status, d.operator_epoch,
         s.expires_at, s.revoked_at
  FROM nightclub.device_sessions s
  JOIN nightclub.devices d ON d.tenant_id = s.tenant_id AND d.store_id = s.store_id
                          AND d.id = s.device_id
  WHERE s.token_hash = p_token_hash
$$;

CREATE OR REPLACE FUNCTION nightclub.operator_resolve_session(p_token_hash text)
  RETURNS TABLE(session_id uuid, tenant_id uuid, store_id uuid, event_id uuid,
                device_id uuid, device_session_id uuid, membership_id uuid,
                operator_epoch bigint, device_epoch bigint, device_status text,
                member_status text, member_user_id uuid, member_display_name text,
                expires_at timestamptz, locked_at timestamptz, ended_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nightclub, public AS $$
  SELECT o.id, o.tenant_id, o.store_id, o.event_id, o.device_id,
         o.device_session_id, o.membership_id, o.operator_epoch,
         d.operator_epoch, d.status, m.status, m.user_id, m.display_name,
         o.expires_at, o.locked_at, o.ended_at
  FROM nightclub.operator_sessions o
  JOIN nightclub.devices d ON d.tenant_id = o.tenant_id AND d.store_id = o.store_id
                          AND d.id = o.device_id
  JOIN nightclub.memberships m ON m.tenant_id = o.tenant_id AND m.store_id = o.store_id
                              AND m.id = o.membership_id
  WHERE o.token_hash = p_token_hash
$$;

-- Kiosk operator pick-list: names of members who may unlock this device.
-- operator_credentials stays deny-all; this exposes only id+display_name.
CREATE OR REPLACE FUNCTION nightclub.device_operator_candidates()
  RETURNS TABLE(membership_id uuid, display_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nightclub, public AS $$
  SELECT m.id, m.display_name
  FROM nightclub.memberships m
  WHERE m.tenant_id = nightclub.ctx_tenant()
    AND m.store_id = nightclub.ctx_store()
    AND m.status = 'ACTIVE'
    AND (m.valid_to IS NULL OR m.valid_to > CURRENT_TIMESTAMP)
    AND EXISTS (
      SELECT 1 FROM nightclub.membership_roles mr
      JOIN nightclub.role_permissions rp
        ON rp.tenant_id = mr.tenant_id AND rp.store_id = mr.store_id
       AND rp.role_id = mr.role_id
      WHERE mr.tenant_id = m.tenant_id AND mr.store_id = m.store_id
        AND mr.membership_id = m.id
        AND rp.permission_key = 'device.unlock'
        AND (mr.expires_at IS NULL OR mr.expires_at > CURRENT_TIMESTAMP))
    AND EXISTS (
      SELECT 1 FROM nightclub.operator_credentials oc
      WHERE oc.tenant_id = m.tenant_id AND oc.store_id = m.store_id
        AND oc.membership_id = m.id)
  ORDER BY m.display_name
$$;

-- PIN verification: hash never leaves the DB side channel unscoped; bound to
-- the tenant/store GUCs established by the device cookie.
CREATE OR REPLACE FUNCTION nightclub.operator_credential_get(p_membership_id uuid)
  RETURNS TABLE(pin_hash text, failed_attempts integer, locked_until timestamptz,
                credential_version integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nightclub, public AS $$
  SELECT c.pin_hash, c.failed_attempts, c.locked_until, c.credential_version
  FROM nightclub.operator_credentials c
  JOIN nightclub.memberships m ON m.tenant_id = c.tenant_id AND m.store_id = c.store_id
                              AND m.id = c.membership_id
  WHERE c.membership_id = p_membership_id
    AND c.tenant_id = nightclub.ctx_tenant()
    AND c.store_id = nightclub.ctx_store()
    AND m.status = 'ACTIVE'
$$;

CREATE OR REPLACE FUNCTION nightclub.operator_credential_update(
  p_membership_id uuid, p_success boolean, p_max_attempts integer,
  p_lock_seconds integer
) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = nightclub, public AS $$
BEGIN
  IF p_success THEN
    UPDATE nightclub.operator_credentials
      SET failed_attempts = 0, locked_until = NULL,
          version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE membership_id = p_membership_id
        AND tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store();
  ELSE
    UPDATE nightclub.operator_credentials
      SET failed_attempts = failed_attempts + 1,
          locked_until = CASE
            WHEN failed_attempts + 1 >= p_max_attempts
              THEN CURRENT_TIMESTAMP + make_interval(secs => p_lock_seconds)
            ELSE locked_until END,
          version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE membership_id = p_membership_id
        AND tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store();
  END IF;
END $$;

-- outbox worker claim (SKIP LOCKED) + publish mark.
CREATE OR REPLACE FUNCTION nightclub.outbox_claim(p_limit integer)
  RETURNS SETOF nightclub.outbox_events
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = nightclub, public AS $$
  UPDATE nightclub.outbox_events SET attempts = attempts + 1,
    updated_at = CURRENT_TIMESTAMP
  WHERE id IN (
    SELECT id FROM nightclub.outbox_events
    WHERE published_at IS NULL
    ORDER BY tenant_id, store_id, event_id, stream_seq
    FOR UPDATE SKIP LOCKED LIMIT p_limit)
  RETURNING *
$$;

CREATE OR REPLACE FUNCTION nightclub.outbox_mark_published(p_ids uuid[])
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = nightclub, public AS $$
  UPDATE nightclub.outbox_events SET published_at = CURRENT_TIMESTAMP
  WHERE id = ANY(p_ids)
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA nightclub FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA nightclub TO app_runtime;
-- readonly gets only the GUC helpers, never the SECURITY DEFINER bridges.
GRANT EXECUTE ON FUNCTION nightclub.ctx_scope() TO app_readonly;
GRANT EXECUTE ON FUNCTION nightclub.ctx_tenant() TO app_readonly;
GRANT EXECUTE ON FUNCTION nightclub.ctx_store() TO app_readonly;
GRANT EXECUTE ON FUNCTION nightclub.ctx_user() TO app_readonly;
GRANT EXECUTE ON FUNCTION nightclub.ctx_member() TO app_readonly;
GRANT EXECUTE ON FUNCTION nightclub.ctx_device() TO app_readonly;
GRANT EXECUTE ON FUNCTION nightclub.ctx_device_session() TO app_readonly;
GRANT EXECUTE ON FUNCTION nightclub.ctx_operator_session() TO app_readonly;
GRANT EXECUTE ON FUNCTION nightclub.ctx_event() TO app_readonly;

-- ------------------------------------------------------------- indexes -----
CREATE INDEX IF NOT EXISTS customers_name_trgm
  ON nightclub.customers USING gin (name_key gin_trgm_ops);
CREATE INDEX IF NOT EXISTS customers_kana_trgm
  ON nightclub.customers USING gin (kana_key gin_trgm_ops);
CREATE INDEX IF NOT EXISTS visits_name_trgm
  ON nightclub.visits USING gin (name_key gin_trgm_ops);
CREATE INDEX IF NOT EXISTS visits_event_status
  ON nightclub.visits (tenant_id, store_id, event_id, status);
CREATE INDEX IF NOT EXISTS visits_event_arrival
  ON nightclub.visits (tenant_id, store_id, event_id, arrival_status);
CREATE INDEX IF NOT EXISTS visits_referrer
  ON nightclub.visits (tenant_id, store_id, event_id, referrer_membership_id);
CREATE INDEX IF NOT EXISTS approval_requests_pending
  ON nightclub.approval_requests (tenant_id, store_id, event_id)
  WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS approval_decisions_request
  ON nightclub.approval_decisions (tenant_id, store_id, event_id, request_id);
CREATE INDEX IF NOT EXISTS outbox_pending
  ON nightclub.outbox_events (tenant_id, store_id, event_id, stream_seq)
  WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS admission_events_visit
  ON nightclub.admission_events (tenant_id, store_id, event_id, visit_id);
CREATE INDEX IF NOT EXISTS entry_passes_visit
  ON nightclub.entry_passes (tenant_id, store_id, event_id, visit_id);
CREATE INDEX IF NOT EXISTS bookings_event_status
  ON nightclub.bookings (tenant_id, store_id, event_id, status);
CREATE INDEX IF NOT EXISTS table_allocations_table
  ON nightclub.table_allocations (tenant_id, store_id, event_id, table_id);
CREATE INDEX IF NOT EXISTS operator_sessions_device_active
  ON nightclub.operator_sessions (tenant_id, store_id, device_id)
  WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS device_sessions_device
  ON nightclub.device_sessions (tenant_id, store_id, device_id);
CREATE INDEX IF NOT EXISTS audit_logs_target
  ON nightclub.audit_logs (tenant_id, store_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS audit_logs_time
  ON nightclub.audit_logs (tenant_id, store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS command_receipts_expiry
  ON nightclub.command_receipts (expires_at);
CREATE INDEX IF NOT EXISTS payments_order
  ON nightclub.payments (tenant_id, store_id, event_id, order_id);
CREATE INDEX IF NOT EXISTS sync_acks_device
  ON nightclub.sync_acks (tenant_id, store_id, event_id, device_id);

-- ------------------------------------------------------------ triggers -----
CREATE OR REPLACE FUNCTION nightclub.nc_touch() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT DISTINCT table_name FROM information_schema.columns
    WHERE table_schema = 'nightclub' AND column_name = 'updated_at'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER nc_touch BEFORE UPDATE ON nightclub.%I
       FOR EACH ROW EXECUTE FUNCTION nightclub.nc_touch()', t.table_name);
  END LOOP;
END $$;

COMMIT;
