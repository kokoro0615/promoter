-- 0003_r2_r3.sql — R2 (EP24/25 platform & tenant lifecycle) + R3 (EP26/27
-- tickets, products/inventory/POS, bottle keeps, private events) additions.
-- Reference DDL (0001) stays untouched; additive tables/ALTERs only.

SET client_min_messages = warning;

-- ------------------------------------------------------- EP24: platform ----
-- SaaS operator registry. Membership in this table gates /platform/* routes;
-- checked via SECURITY DEFINER so app_runtime cannot enumerate it directly.
CREATE TABLE nightclub.platform_operators (
  user_id uuid PRIMARY KEY REFERENCES nightclub.app_users (id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE nightclub.platform_operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.platform_operators FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.platform_operators FROM PUBLIC;

CREATE OR REPLACE FUNCTION nightclub.platform_is_operator()
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = nightclub, public AS $$
  SELECT EXISTS (SELECT 1 FROM nightclub.platform_operators
                 WHERE user_id = nightclub.ctx_user())
$$;

CREATE TABLE nightclub.plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  monthly_price_minor bigint CHECK (monthly_price_minor IS NULL OR monthly_price_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'JPY',
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE nightclub.plans IS 'SaaS プラン。価格は D-10 確定まで NULL 可。';
ALTER TABLE nightclub.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.plans FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.plans FROM PUBLIC;

CREATE TABLE nightclub.tenant_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES nightclub.tenants (id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL REFERENCES nightclub.plans (id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'TRIAL'
    CHECK (status IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED')),
  trial_ends_at timestamptz,
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  canceled_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id),
  CHECK (current_period_end > current_period_start),
  CHECK (status <> 'TRIAL' OR trial_ends_at IS NOT NULL)
);
COMMENT ON TABLE nightclub.tenant_subscriptions IS 'テナント契約状態。';
ALTER TABLE nightclub.tenant_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.tenant_subscriptions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.tenant_subscriptions FROM PUBLIC;
-- only one non-canceled subscription per tenant
CREATE UNIQUE INDEX tenant_subscriptions_one_active
  ON nightclub.tenant_subscriptions (tenant_id) WHERE status <> 'CANCELED';

CREATE TABLE nightclub.billing_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'ISSUED', 'PAID', 'FAILED', 'VOID')),
  due_at timestamptz,
  paid_at timestamptz,
  external_ref text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, subscription_id, period_start),
  FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES nightclub.tenant_subscriptions (tenant_id, id) ON DELETE RESTRICT
);
COMMENT ON TABLE nightclub.billing_invoices IS 'SaaS 請求。外部請求書連携は external_ref。';
ALTER TABLE nightclub.billing_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.billing_invoices FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.billing_invoices FROM PUBLIC;

CREATE TABLE nightclub.tenant_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES nightclub.tenants (id) ON DELETE RESTRICT,
  requested_by uuid NOT NULL REFERENCES nightclub.app_users (id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'SCHEDULED'
    CHECK (status IN ('SCHEDULED', 'CANCELED', 'EXECUTED')),
  execute_after timestamptz NOT NULL,
  executed_at timestamptz,
  export_object_key text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id)
);
COMMENT ON TABLE nightclub.tenant_deletion_requests IS '解約時削除予約。保持期間後に実行。';
ALTER TABLE nightclub.tenant_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.tenant_deletion_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.tenant_deletion_requests FROM PUBLIC;

CREATE TABLE nightclub.tenant_onboarding (
  tenant_id uuid NOT NULL REFERENCES nightclub.tenants (id) ON DELETE CASCADE,
  item_key text NOT NULL,
  done_at timestamptz,
  done_by uuid,
  PRIMARY KEY (tenant_id, item_key)
);
COMMENT ON TABLE nightclub.tenant_onboarding IS '導入チェックリスト。';
ALTER TABLE nightclub.tenant_onboarding ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.tenant_onboarding FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.tenant_onboarding FROM PUBLIC;

-- ----------------------------------------------------- EP26: tickets -------
CREATE TABLE nightclub.ticket_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  currency char(3) NOT NULL,
  sales_from timestamptz NOT NULL,
  sales_to timestamptz NOT NULL,
  quantity_limit integer CHECK (quantity_limit IS NULL OR quantity_limit > 0),
  per_order_limit integer NOT NULL DEFAULT 4 CHECK (per_order_limit > 0),
  status text NOT NULL DEFAULT 'ON_SALE'
    CHECK (status IN ('DRAFT', 'ON_SALE', 'PAUSED', 'CLOSED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, event_id, code),
  FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, event_id)
    REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT,
  CHECK (sales_to > sales_from)
);
COMMENT ON TABLE nightclub.ticket_products IS '事前販売の券種。';
ALTER TABLE nightclub.ticket_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.ticket_products FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.ticket_products FROM PUBLIC;

CREATE TABLE nightclub.ticket_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  product_id uuid NOT NULL,
  buyer_membership_id uuid,
  buyer_customer_id uuid,
  buyer_name text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'PAID'
    CHECK (status IN ('PAID', 'CANCELED', 'REFUNDED')),
  payment_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, event_id)
    REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, event_id, product_id)
    REFERENCES nightclub.ticket_products (tenant_id, store_id, event_id, id) ON DELETE RESTRICT
);
COMMENT ON TABLE nightclub.ticket_orders IS '券の販売伝票。支払は payments と連携。';
ALTER TABLE nightclub.ticket_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.ticket_orders FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.ticket_orders FROM PUBLIC;

CREATE TABLE nightclub.ticket_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  order_id uuid NOT NULL,
  product_id uuid NOT NULL,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'ISSUED'
    CHECK (status IN ('ISSUED', 'REDEEMED', 'VOID', 'REFUNDED')),
  redeemed_visit_id uuid,
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, token_hash),
  FOREIGN KEY (tenant_id, store_id, event_id, order_id)
    REFERENCES nightclub.ticket_orders (tenant_id, store_id, event_id, id) ON DELETE RESTRICT,
  CHECK (status <> 'REDEEMED' OR (redeemed_visit_id IS NOT NULL AND redeemed_at IS NOT NULL))
);
COMMENT ON TABLE nightclub.ticket_instances IS 'QR券インスタンス。tokenはhashのみ保存。';
ALTER TABLE nightclub.ticket_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.ticket_instances FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.ticket_instances FROM PUBLIC;

-- ------------------------------------------------ EP27: products / POS -----
CREATE TABLE nightclub.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  sku text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('BOTTLE', 'ITEM', 'PACKAGE')),
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  currency char(3) NOT NULL,
  stock_tracked boolean NOT NULL DEFAULT false,
  stock_on_hand integer NOT NULL DEFAULT 0 CHECK (stock_on_hand >= 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, sku),
  FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT
);
COMMENT ON TABLE nightclub.products IS 'POS/事前購入の商品。stock_on_handはmovementsの写し。';
ALTER TABLE nightclub.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.products FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.products FROM PUBLIC;

CREATE TABLE nightclub.stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('IN', 'OUT', 'ADJUST', 'SALE', 'RETURN')),
  quantity integer NOT NULL CHECK (quantity <> 0),
  ref text,
  created_by uuid,
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, operation_id, product_id, kind),
  FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, product_id)
    REFERENCES nightclub.products (tenant_id, store_id, id) ON DELETE RESTRICT
);
COMMENT ON TABLE nightclub.stock_movements IS '在庫増減台帳。追記専用。';
ALTER TABLE nightclub.stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.stock_movements FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.stock_movements FROM PUBLIC;

CREATE TABLE nightclub.bottle_keeps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  product_id uuid NOT NULL,
  order_id uuid,
  label text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  remaining_percent integer NOT NULL DEFAULT 100 CHECK (remaining_percent BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FINISHED', 'DISCARDED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES nightclub.customers (tenant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, product_id)
    REFERENCES nightclub.products (tenant_id, store_id, id) ON DELETE RESTRICT
);
COMMENT ON TABLE nightclub.bottle_keeps IS 'ボトルキープ台帳。';
ALTER TABLE nightclub.bottle_keeps ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.bottle_keeps FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.bottle_keeps FROM PUBLIC;

-- ------------------------------------------------- ALTERs to reference -----
ALTER TABLE nightclub.events ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN nightclub.events.is_private IS '貸切営業。R3。';

ALTER TABLE nightclub.sales_orders DROP CONSTRAINT sales_orders_kind_check;
ALTER TABLE nightclub.sales_orders
  ADD CONSTRAINT sales_orders_kind_check
  CHECK (kind IN ('ADMISSION', 'VIP', 'IN_VENUE', 'TICKET', 'POS'));
ALTER TABLE nightclub.sales_orders ALTER COLUMN visit_id DROP NOT NULL;

ALTER TABLE nightclub.sales_lines DROP CONSTRAINT sales_lines_category_check;
ALTER TABLE nightclub.sales_lines
  ADD CONSTRAINT sales_lines_category_check
  CHECK (category IN ('ADMISSION', 'VIP', 'IN_VENUE', 'CANCELLATION', 'REENTRY', 'TICKET', 'PRODUCT'));

ALTER TABLE nightclub.payments DROP CONSTRAINT payments_purpose_check;
ALTER TABLE nightclub.payments
  ADD CONSTRAINT payments_purpose_check
  CHECK (purpose IN ('DEPOSIT', 'FINAL', 'ADMISSION', 'TICKET', 'PRODUCT'));

ALTER TABLE nightclub.admission_segments DROP CONSTRAINT admission_segments_authorization_method_check;
ALTER TABLE nightclub.admission_segments
  ADD CONSTRAINT admission_segments_authorization_method_check
  CHECK (authorization_method IN ('STANDARD', 'TRUSTED_ACTOR', 'CUSTOMER_PERMIT', 'MANUAL', 'TICKET'));

-- ------------------------------------------------------------- RLS ---------
-- platform tables: system scope only (platform routes verify operator first)
CREATE POLICY nc_platform_operators ON nightclub.platform_operators
  FOR ALL TO app_runtime USING (nightclub.ctx_scope() = 'system')
  WITH CHECK (nightclub.ctx_scope() = 'system');
CREATE POLICY nc_plans ON nightclub.plans
  FOR ALL TO app_runtime USING (nightclub.ctx_scope() = 'system')
  WITH CHECK (nightclub.ctx_scope() = 'system');
CREATE POLICY nc_tenant_subscriptions ON nightclub.tenant_subscriptions
  FOR ALL TO app_runtime USING (nightclub.ctx_scope() = 'system')
  WITH CHECK (nightclub.ctx_scope() = 'system');
CREATE POLICY nc_billing_invoices ON nightclub.billing_invoices
  FOR ALL TO app_runtime USING (nightclub.ctx_scope() = 'system')
  WITH CHECK (nightclub.ctx_scope() = 'system');
CREATE POLICY nc_tenant_deletion ON nightclub.tenant_deletion_requests
  FOR ALL TO app_runtime USING (nightclub.ctx_scope() = 'system')
  WITH CHECK (nightclub.ctx_scope() = 'system');
CREATE POLICY nc_tenant_onboarding ON nightclub.tenant_onboarding
  FOR ALL TO app_runtime USING (nightclub.ctx_scope() = 'system')
  WITH CHECK (nightclub.ctx_scope() = 'system');

-- Platform-scope idempotency + audit: command_receipts/audit_logs are keyed
-- NOT NULL on (tenant_id, store_id), so cross-tenant platform commands need
-- their own stores. Reachable only under system scope with a verified
-- platform operator (platform_is_operator reads the app.user_id GUC).
CREATE TABLE nightclub.platform_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_key text NOT NULL,
  operation_key text NOT NULL,
  operation_name text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('PROCESSING', 'SUCCEEDED', 'REJECTED')),
  http_status integer,
  response_body jsonb,
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (actor_key, operation_name, operation_key)
);
ALTER TABLE nightclub.platform_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.platform_command_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.platform_command_receipts FROM PUBLIC;
CREATE POLICY nc_platform_command_receipts ON nightclub.platform_command_receipts
  FOR ALL TO app_runtime
  USING (nightclub.ctx_scope() = 'system' AND nightclub.platform_is_operator())
  WITH CHECK (nightclub.ctx_scope() = 'system' AND nightclub.platform_is_operator());

CREATE TABLE nightclub.platform_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  actor_user_id uuid NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  before_version integer,
  after_version integer,
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE nightclub.platform_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.platform_audit_logs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.platform_audit_logs FROM PUBLIC;
CREATE POLICY nc_platform_audit_sel ON nightclub.platform_audit_logs
  FOR SELECT TO app_runtime, app_readonly
  USING (nightclub.platform_is_operator());
CREATE POLICY nc_platform_audit_ins ON nightclub.platform_audit_logs
  FOR INSERT TO app_runtime
  WITH CHECK (nightclub.ctx_scope() = 'system' AND nightclub.platform_is_operator());

-- store-scoped tables: standard tenant+store policy
CREATE POLICY nc_ticket_products ON nightclub.ticket_products
  FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'device', 'operator', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'));
CREATE POLICY nc_ticket_orders ON nightclub.ticket_orders
  FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'device', 'operator', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'));
CREATE POLICY nc_ticket_instances ON nightclub.ticket_instances
  FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'device', 'operator', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'));
CREATE POLICY nc_products ON nightclub.products
  FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'device', 'operator', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'));
CREATE POLICY nc_stock_movements ON nightclub.stock_movements
  FOR SELECT TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'device', 'operator', 'system'));
CREATE POLICY nc_stock_movements_ins ON nightclub.stock_movements
  FOR INSERT TO app_runtime
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'));
CREATE POLICY nc_bottle_keeps ON nightclub.bottle_keeps
  FOR ALL TO app_runtime, app_readonly
  USING (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
         AND nightclub.ctx_scope() IN ('personal', 'device', 'operator', 'system'))
  WITH CHECK (tenant_id = nightclub.ctx_tenant() AND store_id = nightclub.ctx_store()
              AND nightclub.ctx_scope() IN ('personal', 'operator', 'system'));

-- ------------------------------------------------------------- grants ------
GRANT SELECT, INSERT, UPDATE ON nightclub.platform_operators TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON nightclub.plans TO app_runtime;
GRANT SELECT ON nightclub.plans TO app_readonly;
GRANT SELECT, INSERT, UPDATE ON nightclub.tenant_subscriptions TO app_runtime;
GRANT SELECT ON nightclub.tenant_subscriptions TO app_readonly;
GRANT SELECT, INSERT, UPDATE ON nightclub.billing_invoices TO app_runtime;
GRANT SELECT ON nightclub.billing_invoices TO app_readonly;
GRANT SELECT, INSERT, UPDATE ON nightclub.tenant_deletion_requests TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON nightclub.tenant_onboarding TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON nightclub.platform_command_receipts TO app_runtime;
GRANT SELECT, INSERT ON nightclub.platform_audit_logs TO app_runtime;
GRANT SELECT ON nightclub.platform_audit_logs TO app_readonly;
GRANT SELECT, INSERT, UPDATE ON nightclub.ticket_products TO app_runtime;
GRANT SELECT ON nightclub.ticket_products TO app_readonly;
GRANT SELECT, INSERT, UPDATE ON nightclub.ticket_orders TO app_runtime;
GRANT SELECT ON nightclub.ticket_orders TO app_readonly;
GRANT SELECT, INSERT, UPDATE ON nightclub.ticket_instances TO app_runtime;
GRANT SELECT ON nightclub.ticket_instances TO app_readonly;
GRANT SELECT, INSERT, UPDATE ON nightclub.products TO app_runtime;
GRANT SELECT ON nightclub.products TO app_readonly;
GRANT SELECT, INSERT ON nightclub.stock_movements TO app_runtime;
GRANT SELECT ON nightclub.stock_movements TO app_readonly;
GRANT SELECT, INSERT, UPDATE ON nightclub.bottle_keeps TO app_runtime;
GRANT SELECT ON nightclub.bottle_keeps TO app_readonly;
GRANT EXECUTE ON FUNCTION nightclub.platform_is_operator() TO app_runtime;
