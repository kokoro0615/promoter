-- 0004_v5_completion.sql
-- v5 completion additive migration. No applied migration is rewritten.
--   * bookings without a pre-existing visit (public/phone/private bookings)
--   * quotations + quotation_lines (private events / 見積)
--   * booking_pages (unauthenticated public booking forms)
--   * notification inbox (payload + read marks, non-event notifications)
--   * auth alternatives: email-link tokens, TOTP credentials, recovery codes
--   * integration_events tolerate unmatched provider references
--   * stores.settings (branding/locale), bookings.contact (unverified contact)
--   * CRM minimum: customer_tags(+assignments), campaigns(+deliveries)
--   * demand forecast runs, stocktaking sessions
-- Depends on: 0001, 0002, 0003.
BEGIN;

-- ---------------------------------------------------------- alterations ----
ALTER TABLE nightclub.bookings ALTER COLUMN visit_id DROP NOT NULL;
ALTER TABLE nightclub.bookings ADD COLUMN IF NOT EXISTS contact jsonb;

-- Booking deposit sales orders are created at checkout, before any visit
-- exists. bookings.visit_id is nullable (above), so the order's visit link
-- must be nullable too.
ALTER TABLE nightclub.sales_orders ALTER COLUMN visit_id DROP NOT NULL;
COMMENT ON COLUMN nightclub.bookings.contact IS
  'Unverified public/private booking contact payload (name/phone/note). Never treated as identity.';

ALTER TABLE nightclub.notification_jobs ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE nightclub.notification_jobs ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}';

ALTER TABLE nightclub.integration_events ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE nightclub.integration_events ALTER COLUMN store_id DROP NOT NULL;

-- Provider webhooks arrive without session context. Bare system scope must
-- locate the payment row by its globally-unique provider reference before
-- tenant/store GUCs can be set; the mutation itself then runs in a second
-- transaction under the resolved tenant context. SELECT-only grant, same
-- trust level as the export_jobs worker precedent.
CREATE POLICY nc_payments_system_lookup ON nightclub.payments FOR SELECT
  TO app_runtime
  USING (nightclub.ctx_scope() = 'system');

ALTER TABLE nightclub.stores ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}';
COMMENT ON COLUMN nightclub.stores.settings IS
  'Branding/locale options: {brand_name, logo_url, accent_color, locales[], default_locale}.';

-- ------------------------------------------------------------ quotations ---
CREATE TABLE nightclub.quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  booking_id uuid,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','ISSUED','ACCEPTED','DECLINED','EXPIRED','CANCELED')),
  total_minor bigint NOT NULL DEFAULT 0 CHECK (total_minor>=0),
  currency char(3) NOT NULL,
  valid_until timestamptz,
  note text,
  issued_by uuid,
  issued_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  FOREIGN KEY (tenant_id, store_id, event_id, booking_id)
    REFERENCES nightclub.bookings (tenant_id, store_id, event_id, id)
);
COMMENT ON TABLE nightclub.quotations IS '貸切/VIP見積。状態遷移は明示コマンドのみ。';

CREATE TABLE nightclub.quotation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  quotation_id uuid NOT NULL,
  description text NOT NULL,
  quantity integer NOT NULL CHECK (quantity>0),
  unit_minor bigint NOT NULL CHECK (unit_minor>=0),
  amount_minor bigint NOT NULL CHECK (amount_minor>=0),
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  FOREIGN KEY (tenant_id, store_id, event_id, quotation_id)
    REFERENCES nightclub.quotations (tenant_id, store_id, event_id, id)
);
ALTER TABLE nightclub.quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.quotations FORCE ROW LEVEL SECURITY;
ALTER TABLE nightclub.quotation_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.quotation_lines FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------- booking pages --
CREATE TABLE nightclub.booking_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  title text NOT NULL,
  message text,
  collect_phone boolean NOT NULL DEFAULT true,
  max_party integer NOT NULL DEFAULT 10 CHECK (max_party>0),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (slug)
);
COMMENT ON TABLE nightclub.booking_pages IS
  '公開予約フォーム定義。slugはグローバル一意（公開URLのため）。投稿はbookings(contact)へ。';
ALTER TABLE nightclub.booking_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.booking_pages FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------------ notification inbox --
CREATE TABLE nightclub.notification_reads (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  notification_job_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  read_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, store_id, notification_job_id, membership_id)
);
ALTER TABLE nightclub.notification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.notification_reads FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------------- auth alternatives --
-- Pre-auth tables: deny-all RLS (no runtime policies) -> reachable only
-- through the SECURITY DEFINER bridges below.
CREATE TABLE nightclub.email_login_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  token_hash text NOT NULL,
  user_id uuid,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (token_hash)
);
ALTER TABLE nightclub.email_login_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.email_login_tokens FORCE ROW LEVEL SECURITY;

CREATE TABLE nightclub.mfa_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES nightclub.app_users (id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('TOTP')),
  secret text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','DISABLED')),
  verified_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, kind)
);
ALTER TABLE nightclub.mfa_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.mfa_credentials FORCE ROW LEVEL SECURITY;

CREATE TABLE nightclub.mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES nightclub.app_users (id) ON DELETE RESTRICT,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, code_hash)
);
ALTER TABLE nightclub.mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.mfa_recovery_codes FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------ CRM ----
CREATE TABLE nightclub.customer_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  tag_key text NOT NULL CHECK (tag_key ~ '^[a-z0-9_]{1,40}$'),
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, tag_key)
);
ALTER TABLE nightclub.customer_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.customer_tags FORCE ROW LEVEL SECURITY;

CREATE TABLE nightclub.customer_tag_assignments (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  assigned_by uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, store_id, customer_id, tag_id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES nightclub.customers (tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, tag_id)
    REFERENCES nightclub.customer_tags (tenant_id, store_id, id)
);
ALTER TABLE nightclub.customer_tag_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.customer_tag_assignments FORCE ROW LEVEL SECURITY;

CREATE TABLE nightclub.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  name text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('IN_APP','EMAIL','LINE','PUSH')),
  segment jsonb NOT NULL DEFAULT '{}',
  body text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SCHEDULED','SENDING','SENT','CANCELED')),
  scheduled_at timestamptz,
  sent_at timestamptz,
  created_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id)
);
ALTER TABLE nightclub.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.campaigns FORCE ROW LEVEL SECURITY;

CREATE TABLE nightclub.campaign_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  recipient_customer_id uuid,
  recipient_membership_id uuid,
  dedup_key text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','SENT','FAILED','SUPPRESSED')),
  provider_reference text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, campaign_id, dedup_key),
  CHECK (num_nonnulls(recipient_customer_id, recipient_membership_id)=1),
  FOREIGN KEY (tenant_id, store_id, campaign_id)
    REFERENCES nightclub.campaigns (tenant_id, store_id, id)
);
ALTER TABLE nightclub.campaign_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.campaign_deliveries FORCE ROW LEVEL SECURITY;

-- -------------------------------------------------------------- forecast ---
CREATE TABLE nightclub.forecast_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid,
  model text NOT NULL,
  horizon_days integer NOT NULL CHECK (horizon_days>0),
  metrics jsonb NOT NULL,
  generated_by uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id)
);
ALTER TABLE nightclub.forecast_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.forecast_runs FORCE ROW LEVEL SECURITY;

-- -------------------------------------------------------------- stocktake --
CREATE TABLE nightclub.stocktakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','CANCELED')),
  started_by uuid NOT NULL,
  closed_by uuid,
  closed_at timestamptz,
  note text,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id)
);
ALTER TABLE nightclub.stocktakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.stocktakes FORCE ROW LEVEL SECURITY;

CREATE TABLE nightclub.stocktake_lines (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  stocktake_id uuid NOT NULL,
  product_id uuid NOT NULL,
  expected_qty integer NOT NULL,
  counted_qty integer,
  counted_by uuid,
  counted_at timestamptz,
  PRIMARY KEY (tenant_id, store_id, stocktake_id, product_id),
  FOREIGN KEY (tenant_id, store_id, stocktake_id)
    REFERENCES nightclub.stocktakes (tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id)
    REFERENCES nightclub.products (tenant_id, store_id, id)
);
ALTER TABLE nightclub.stocktake_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.stocktake_lines FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------------------- RLS ---------
DO $$
DECLARE
  t text;
  store_tables text[] := ARRAY[
    'booking_pages', 'notification_reads', 'customer_tags',
    'customer_tag_assignments', 'campaigns', 'campaign_deliveries',
    'forecast_runs', 'stocktakes', 'stocktake_lines'
  ];
  event_tables text[] := ARRAY['quotations', 'quotation_lines'];
BEGIN
  FOREACH t IN ARRAY store_tables LOOP
    EXECUTE format(
      'CREATE POLICY nc_%I ON nightclub.%I FOR ALL TO app_runtime, app_readonly
         USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
                AND nightclub.ctx_scope() IN (''personal'', ''system''))
         WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
                AND nightclub.ctx_scope() IN (''personal'', ''system''))',
      replace(t, '_', ''), t);
  END LOOP;
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
END $$;

-- ------------------------------------------- SECURITY DEFINER bridges ------
-- Pre-auth + personal-scope bridges for the new auth tables (deny-all above).

-- Personal-scope bridge: caller reads own MFA state only (ctx_user() bound).
CREATE OR REPLACE FUNCTION nightclub.mfa_state()
  RETURNS TABLE(kind text, status text, recovery_remaining integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nightclub, public AS $$
  SELECT c.kind, c.status,
         (SELECT count(*)::int FROM nightclub.mfa_recovery_codes rc
           WHERE rc.user_id = c.user_id AND rc.used_at IS NULL)
    FROM nightclub.mfa_credentials c
   WHERE c.user_id = nightclub.ctx_user()
$$;

CREATE OR REPLACE FUNCTION nightclub.mfa_totp_begin(p_secret text)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = nightclub, public AS $$
  INSERT INTO nightclub.mfa_credentials (user_id, kind, secret, status)
  VALUES (nightclub.ctx_user(), 'TOTP', p_secret, 'PENDING')
  ON CONFLICT (user_id, kind)
  DO UPDATE SET secret = EXCLUDED.secret, status = 'PENDING',
                verified_at = NULL, version = mfa_credentials.version + 1,
                updated_at = CURRENT_TIMESTAMP
$$;

CREATE OR REPLACE FUNCTION nightclub.mfa_totp_activate()
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = nightclub, public AS $$
  UPDATE nightclub.mfa_credentials
     SET status = 'ACTIVE', verified_at = CURRENT_TIMESTAMP,
         version = version + 1, updated_at = CURRENT_TIMESTAMP
   WHERE user_id = nightclub.ctx_user() AND kind = 'TOTP' AND status = 'PENDING'
$$;

CREATE OR REPLACE FUNCTION nightclub.mfa_totp_disable()
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = nightclub, public AS $$
  UPDATE nightclub.mfa_credentials
     SET status = 'DISABLED', version = version + 1, updated_at = CURRENT_TIMESTAMP
   WHERE user_id = nightclub.ctx_user() AND kind = 'TOTP'
$$;

CREATE OR REPLACE FUNCTION nightclub.mfa_totp_secret()
  RETURNS TABLE(secret text, status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nightclub, public AS $$
  SELECT c.secret, c.status FROM nightclub.mfa_credentials c
   WHERE c.user_id = nightclub.ctx_user() AND c.kind = 'TOTP'
$$;

CREATE OR REPLACE FUNCTION nightclub.mfa_recovery_replace(p_hashes text[])
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = nightclub, public AS $$
BEGIN
  DELETE FROM nightclub.mfa_recovery_codes
   WHERE user_id = nightclub.ctx_user() AND used_at IS NULL;
  INSERT INTO nightclub.mfa_recovery_codes (user_id, code_hash)
    SELECT nightclub.ctx_user(), h FROM unnest(p_hashes) AS h;
END $$;

-- Consume a recovery code during step-up (user already session-bound).
CREATE OR REPLACE FUNCTION nightclub.mfa_recovery_consume(p_code_hash text)
  RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = nightclub, public AS $$
  UPDATE nightclub.mfa_recovery_codes SET used_at = CURRENT_TIMESTAMP
   WHERE user_id = nightclub.ctx_user() AND code_hash = p_code_hash
     AND used_at IS NULL
  RETURNING true
$$;

-- Step-up marker on the session (money-sensitive area gate).
CREATE OR REPLACE FUNCTION nightclub.auth_mark_step_up(p_session_id uuid)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = nightclub, public AS $$
  UPDATE nightclub.auth_sessions
     SET step_up_at = CURRENT_TIMESTAMP, version = version + 1,
         updated_at = CURRENT_TIMESTAMP
   WHERE id = p_session_id AND user_id = nightclub.ctx_user()
$$;

-- Email-link bridges (pre-auth, no ctx_user required).
CREATE OR REPLACE FUNCTION nightclub.email_link_issue(
  p_email text, p_token_hash text, p_user_id uuid, p_expires timestamptz
) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = nightclub, public AS $$
  INSERT INTO nightclub.email_login_tokens (email, token_hash, user_id, expires_at)
  VALUES (lower(p_email), p_token_hash, p_user_id, p_expires)
$$;

CREATE OR REPLACE FUNCTION nightclub.email_link_redeem(p_token_hash text)
  RETURNS TABLE(user_id uuid, already_used boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = nightclub, public AS $$
DECLARE
  v_tok nightclub.email_login_tokens%ROWTYPE;
BEGIN
  UPDATE nightclub.email_login_tokens
     SET attempts = attempts + 1
   WHERE token_hash = p_token_hash
  RETURNING * INTO v_tok;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_tok.used_at IS NOT NULL THEN
    RETURN QUERY SELECT NULL::uuid, true; RETURN;
  END IF;
  IF v_tok.expires_at <= CURRENT_TIMESTAMP OR v_tok.attempts > 10 THEN
    RETURN; END IF;
  UPDATE nightclub.email_login_tokens SET used_at = CURRENT_TIMESTAMP
   WHERE id = v_tok.id;
  RETURN QUERY SELECT v_tok.user_id, false;
END $$;

-- Resolve an email-link identity (issuer='email-link', client='login').
CREATE OR REPLACE FUNCTION nightclub.user_by_email_identity(p_email text)
  RETURNS TABLE(user_id uuid, status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nightclub, public AS $$
  SELECT u.id, u.status FROM nightclub.external_identities ei
    JOIN nightclub.app_users u ON u.id = ei.user_id
   WHERE ei.issuer = 'email-link' AND ei.client_id = 'login'
     AND lower(ei.subject) = lower(p_email) LIMIT 1
$$;

-- Bind an email identity to a user (first link creates the identity row).
CREATE OR REPLACE FUNCTION nightclub.email_identity_bind(p_user_id uuid, p_email text)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = nightclub, public AS $$
  INSERT INTO nightclub.external_identities (user_id, issuer, client_id, subject)
  VALUES (p_user_id, 'email-link', 'login', lower(p_email))
  ON CONFLICT (issuer, client_id, subject) DO NOTHING
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA nightclub FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA nightclub TO app_runtime;

COMMIT;
