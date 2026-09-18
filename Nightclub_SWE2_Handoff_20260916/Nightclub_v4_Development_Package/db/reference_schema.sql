-- v4 Reference DDL. Review-only baseline; application commands and production RLS policies are separate.
-- Execute ONLY in an empty isolated development database after reviewing db/README.md.
BEGIN;
CREATE SCHEMA nightclub;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE nightclub.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE nightclub.tenants IS '運営会社単位。外販契約詳細はR2。';

CREATE TABLE nightclub.app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE nightclub.app_users IS '個人主体。ゲスト顧客とは別。';

CREATE TABLE nightclub.external_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  issuer text NOT NULL,
  client_id text NOT NULL,
  subject text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (issuer, client_id, subject)
);
COMMENT ON TABLE nightclub.external_identities IS 'LINE/OIDC等の本人認証主体。';

CREATE TABLE nightclub.auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  step_up_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (token_hash)
);
COMMENT ON TABLE nightclub.auth_sessions IS '個人スマホ用サーバーセッション。外部トークンをブラウザへ渡さない。';

CREATE TABLE nightclub.stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Tokyo',
  currency char(3) NOT NULL DEFAULT 'JPY',
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id)
);
COMMENT ON TABLE nightclub.stores IS '店舗。顧客データを他店と自動共有しない。';

CREATE TABLE nightclub.memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  user_id uuid NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'INVITED' CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'ENDED')),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, user_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
COMMENT ON TABLE nightclub.memberships IS '個人の店舗所属。役職と許可は分離。';

CREATE TABLE nightclub.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  role_key text NOT NULL,
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, role_key)
);
COMMENT ON TABLE nightclub.roles IS '店舗別ロール定義。';

CREATE TABLE nightclub.role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission_key text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, role_id, permission_key)
);
COMMENT ON TABLE nightclub.role_permissions IS 'ロールに付与する許可キー。';

CREATE TABLE nightclub.membership_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  role_id uuid NOT NULL,
  granted_by uuid NOT NULL,
  expires_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, membership_id, role_id)
);
COMMENT ON TABLE nightclub.membership_roles IS '店舗所属とロールの対応。';

CREATE TABLE nightclub.invitation_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  token_hash text NOT NULL,
  invite_target text NOT NULL,
  role_id uuid NOT NULL,
  issued_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (token_hash)
);
COMMENT ON TABLE nightclub.invitation_tokens IS '加入招待。トークンを平文保存しない。';

CREATE TABLE nightclub.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  name text NOT NULL,
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'OPEN', 'RECONCILING', 'CLOSED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  CHECK (closes_at > opens_at)
);
COMMENT ON TABLE nightclub.events IS '営業単位。深夜跨ぎを一つの営業として扱う。';

CREATE TABLE nightclub.event_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  assignment_kind text NOT NULL CHECK (assignment_kind IN ('REFERRER', 'DESIGNATED_APPROVER', 'ENTRANCE', 'ENTRANCE_APPROVER', 'RESERVATION')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, event_id, membership_id, assignment_kind),
  CHECK (ends_at > starts_at)
);
COMMENT ON TABLE nightclub.event_assignments IS '当日権限。入口承認は指定承認者枠とは別。';

CREATE TABLE nightclub.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED')),
  enrolled_by uuid NOT NULL,
  operator_epoch bigint NOT NULL DEFAULT 0 CHECK (operator_epoch >= 0),
  revoked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id)
);
COMMENT ON TABLE nightclub.devices IS '店舗登録済み入口端末。個人とは別主体。';

CREATE TABLE nightclub.device_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  device_id uuid NOT NULL,
  code_hash text NOT NULL,
  issued_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (code_hash)
);
COMMENT ON TABLE nightclub.device_enrollments IS '短期・一回限り端末ペアリング。';

CREATE TABLE nightclub.device_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  device_id uuid NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (token_hash),
  UNIQUE (tenant_id, store_id, device_id, id)
);
COMMENT ON TABLE nightclub.device_sessions IS '端末cookieに対応。単体で顧客を閲覧できない。';

CREATE TABLE nightclub.operator_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  pin_hash text NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  credential_version integer NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, membership_id)
);
COMMENT ON TABLE nightclub.operator_credentials IS '店舗所属ごとの個人PINハッシュと制限。';

CREATE TABLE nightclub.operator_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  device_id uuid NOT NULL,
  device_session_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  operator_epoch bigint NOT NULL CHECK (operator_epoch > 0),
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  locked_at timestamptz,
  ended_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (token_hash)
);
COMMENT ON TABLE nightclub.operator_sessions IS '入口の有効担当者。旧画面はsession/epoch不一致で拒否。';

CREATE TABLE nightclub.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  display_name text NOT NULL,
  name_key text NOT NULL,
  kana_key text,
  regular_status text NOT NULL DEFAULT 'NONE' CHECK (regular_status IN ('NONE', 'DESIGNATED', 'REVOKED')),
  masked_hint text,
  contact_ciphertext text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id)
);
COMMENT ON TABLE nightclub.customers IS '常連を含む顧客台帳。氏名はuniqueではない。';

CREATE TABLE nightclub.customer_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  alias text NOT NULL,
  alias_key text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, customer_id, alias_key)
);
COMMENT ON TABLE nightclub.customer_aliases IS '通称・別名の原文と検索キー。';

CREATE TABLE nightclub.operating_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  name text NOT NULL,
  settings jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id)
);
COMMENT ON TABLE nightclub.operating_templates IS '曜日・営業のテンプレート下書き。設定は型付きJSON。';

CREATE TABLE nightclub.policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED')),
  settings jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz NOT NULL,
  apply_mode text NOT NULL DEFAULT 'NEW_ONLY' CHECK (apply_mode IN ('NEW_ONLY', 'REASSESS_UNENTERED')),
  published_by uuid,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, event_id, version),
  CHECK (effective_to > effective_from)
);
COMMENT ON TABLE nightclub.policy_versions IS '公開設定のスナップショット。公開後は内容不変。';

CREATE TABLE nightclub.price_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  rule_key text NOT NULL,
  price_kind text NOT NULL CHECK (price_kind IN ('NORMAL', 'DISCOUNT', 'FREE')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL,
  entry_from timestamptz NOT NULL,
  entry_to timestamptz NOT NULL,
  payment_required boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, event_id, policy_version_id, rule_key),
  CHECK (price_kind <> 'FREE' OR amount_minor = 0),
  CHECK (entry_to > entry_from)
);
COMMENT ON TABLE nightclub.price_rules IS '設定版に属する料金と入場可能時間。';

CREATE TABLE nightclub.permits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  permit_key uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  subject_kind text NOT NULL CHECK (subject_kind IN ('CUSTOMER', 'ACTOR')),
  customer_id uuid,
  actor_membership_id uuid,
  granted_by uuid NOT NULL,
  conditions jsonb NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  supersedes_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, permit_key, version),
  CHECK (valid_to > valid_from),
  CHECK ((subject_kind = 'CUSTOMER' AND customer_id IS NOT NULL AND actor_membership_id IS NULL) OR (subject_kind = 'ACTOR' AND actor_membership_id IS NOT NULL AND customer_id IS NULL))
);
COMMENT ON TABLE nightclub.permits IS '常連客本人または実登録者への事前許可の版。';

CREATE TABLE nightclub.referrer_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  stage_name text NOT NULL,
  categories text[] NOT NULL DEFAULT '{}',
  contract_reference text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, membership_id)
);
COMMENT ON TABLE nightclub.referrer_profiles IS 'DJ／プロモーター／スタッフの集客プロフィール。';

CREATE TABLE nightclub.invitation_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  referrer_membership_id uuid NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (token_hash)
);
COMMENT ON TABLE nightclub.invitation_links IS '公開招待。帰属は運ぶが内部許可は運ばない。';

CREATE TABLE nightclub.coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code_hash text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  owner_membership_id uuid,
  conditions jsonb NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'REVOKED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, code_hash, version),
  CHECK (valid_to > valid_from)
);
COMMENT ON TABLE nightclub.coupons IS '割引クーポンの版・使用枠。フリー権限とは別。';

CREATE TABLE nightclub.visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  customer_id uuid,
  referrer_membership_id uuid,
  created_by uuid,
  source text NOT NULL CHECK (source IN ('STAFF', 'PUBLIC_LINK', 'VIP_FORM', 'IMPORT', 'WALK_IN')),
  reception_name text NOT NULL,
  name_key text NOT NULL,
  planned_count integer NOT NULL CHECK (planned_count > 0),
  arrival_status text NOT NULL DEFAULT 'UNKNOWN' CHECK (arrival_status IN ('UNKNOWN', 'ON_WAY', 'ARRIVED')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELED', 'NO_SHOW', 'CLOSED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id)
);
COMMENT ON TABLE nightclub.visits IS '来店予定。紹介者・入力者を分離。';

CREATE TABLE nightclub.visit_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  visit_id uuid NOT NULL,
  customer_id uuid,
  display_name text,
  member_kind text NOT NULL CHECK (member_kind IN ('PRINCIPAL', 'COMPANION')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id)
);
COMMENT ON TABLE nightclub.visit_members IS '必要な場合だけ保持する同伴者・本人。';

CREATE TABLE nightclub.customer_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  visit_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  checked_by uuid NOT NULL,
  operator_session_id uuid,
  method text NOT NULL CHECK (method IN ('KNOWN_BY_STAFF', 'BOOKING_CONTEXT', 'CONTACT_HINT', 'OTHER')),
  note text,
  valid_until timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, event_id, visit_id, id)
);
COMMENT ON TABLE nightclub.customer_checks IS '来店時の本人照合の証跡。氏名選択とは別。';

CREATE TABLE nightclub.admission_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  visit_id uuid NOT NULL,
  price_rule_id uuid NOT NULL,
  permit_id uuid,
  required_customer_id uuid,
  requested_count integer NOT NULL CHECK (requested_count > 0),
  authorized_count integer NOT NULL DEFAULT 0 CHECK (authorized_count >= 0),
  first_entered_count integer NOT NULL DEFAULT 0 CHECK (first_entered_count >= 0),
  unit_amount_minor bigint NOT NULL CHECK (unit_amount_minor >= 0),
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'AUTHORIZED', 'REJECTED', 'RETURNED', 'REVOKED', 'EXPIRED')),
  authorization_method text CHECK (authorization_method IN ('STANDARD', 'TRUSTED_ACTOR', 'CUSTOMER_PERMIT', 'MANUAL')),
  snapshot jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  entry_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, event_id, visit_id, id),
  CHECK (first_entered_count <= authorized_count),
  CHECK (authorized_count <= requested_count)
);
COMMENT ON TABLE nightclub.admission_segments IS '来店内の条件別人数。追加・混在を分離。';

CREATE TABLE nightclub.approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  segment_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  request_version integer NOT NULL CHECK (request_version > 0),
  segment_version integer NOT NULL CHECK (segment_version > 0),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'RETURNED', 'SUPERSEDED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, event_id, segment_id, request_version)
);
COMMENT ON TABLE nightclub.approval_requests IS '条件内訳ごとの申請版。確定後の再提出は新しい行。';

CREATE TABLE nightclub.approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  request_id uuid NOT NULL,
  decided_by uuid NOT NULL,
  operator_session_id uuid,
  route text NOT NULL CHECK (route IN ('DESIGNATED', 'ENTRANCE')),
  decision text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED', 'RETURNED')),
  reason text,
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, event_id, request_id),
  UNIQUE (tenant_id, store_id, operation_id),
  CHECK (route <> 'ENTRANCE' OR operator_session_id IS NOT NULL),
  CHECK (decision = 'APPROVED' OR NULLIF(btrim(reason),'') IS NOT NULL)
);
COMMENT ON TABLE nightclub.approval_decisions IS '一申請一決定。通常入口承認を独立した経路で記録。';

CREATE TABLE nightclub.quota_buckets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  bucket_key text NOT NULL,
  bucket_kind text NOT NULL CHECK (bucket_kind IN ('EVENT_HARD', 'ACTOR_BYPASS', 'CUSTOMER', 'MANUAL_DECIDER')),
  limit_mode text NOT NULL CHECK (limit_mode IN ('LIMITED', 'UNLIMITED')),
  limit_count integer CHECK (limit_count IS NULL OR limit_count >= 0),
  held_count integer NOT NULL DEFAULT 0 CHECK (held_count >= 0),
  consumed_count integer NOT NULL DEFAULT 0 CHECK (consumed_count >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, event_id, bucket_key),
  CHECK ((limit_mode='LIMITED' AND limit_count IS NOT NULL AND held_count+consumed_count <= limit_count) OR (limit_mode='UNLIMITED' AND limit_count IS NULL))
);
COMMENT ON TABLE nightclub.quota_buckets IS '営業・紹介者・許可等の枠。設定版を変えて使用量をリセットしない。';

CREATE TABLE nightclub.quota_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  bucket_id uuid NOT NULL,
  segment_id uuid NOT NULL,
  held_count integer NOT NULL DEFAULT 0 CHECK (held_count >= 0),
  consumed_count integer NOT NULL DEFAULT 0 CHECK (consumed_count >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, event_id, bucket_id, segment_id)
);
COMMENT ON TABLE nightclub.quota_allocations IS '条件内訳と各枠の引当。取消の二重返却を防ぐ。';

CREATE TABLE nightclub.entry_passes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  visit_id uuid NOT NULL,
  member_id uuid,
  token_hash text NOT NULL,
  pass_kind text NOT NULL CHECK (pass_kind IN ('GROUP_LOOKUP', 'INDIVIDUAL_REENTRY')),
  presence text NOT NULL DEFAULT 'NOT_ENTERED' CHECK (presence IN ('NOT_ENTERED', 'INSIDE', 'OUTSIDE')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (token_hash),
  UNIQUE (tenant_id, store_id, event_id, visit_id, id)
);
COMMENT ON TABLE nightclub.entry_passes IS '代表QRまたは個別再入場パス。';

CREATE TABLE nightclub.admission_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  visit_id uuid NOT NULL,
  segment_id uuid NOT NULL,
  pass_id uuid,
  operator_session_id uuid NOT NULL,
  actor_membership_id uuid NOT NULL,
  customer_check_id uuid,
  kind text NOT NULL CHECK (kind IN ('FIRST_ENTRY', 'EXIT', 'REENTRY', 'CORRECTION')),
  quantity integer NOT NULL CHECK (quantity > 0),
  present_delta integer NOT NULL,
  first_entry_delta integer NOT NULL,
  corrects_id uuid,
  operation_id uuid NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, operation_id, segment_id),
  CHECK (kind <> 'FIRST_ENTRY' OR (present_delta=quantity AND first_entry_delta=quantity)),
  CHECK (kind <> 'EXIT' OR (present_delta=-quantity AND first_entry_delta=0)),
  CHECK (kind <> 'REENTRY' OR (present_delta=quantity AND first_entry_delta=0 AND pass_id IS NOT NULL AND quantity=1)),
  CHECK (kind <> 'CORRECTION' OR (corrects_id IS NOT NULL AND reason IS NOT NULL))
);
COMMENT ON TABLE nightclub.admission_events IS '追記型入退場台帳。訂正は元行を参照する別記録。';

CREATE TABLE nightclub.provisional_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  device_id uuid NOT NULL,
  actor_membership_id uuid NOT NULL,
  visit_id uuid,
  local_operation_id uuid NOT NULL,
  device_time timestamptz NOT NULL,
  quantity integer NOT NULL CHECK (quantity>0),
  reception_name text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'UNRECONCILED' CHECK (status IN ('UNRECONCILED', 'RECONCILED', 'DUPLICATE', 'REJECTED')),
  reconciled_entry_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, device_id, local_operation_id)
);
COMMENT ON TABLE nightclub.provisional_entries IS '通信断時の責任者による暫定記録。通常実績に混ぜない。';

CREATE TABLE nightclub.floor_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  layout jsonb NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, version)
);
COMMENT ON TABLE nightclub.floor_maps IS '配置の版。tableの物理IDは配置版変更でも維持。';

CREATE TABLE nightclub.venue_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_code text NOT NULL,
  zone text NOT NULL,
  capacity_min integer NOT NULL CHECK (capacity_min>0),
  capacity_max integer NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BLOCKED', 'RETIRED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, table_code),
  CHECK (capacity_max>=capacity_min)
);
COMMENT ON TABLE nightclub.venue_tables IS '物理テーブル。イベントを跨ぐ競合も防ぐ。';

CREATE TABLE nightclub.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  visit_id uuid NOT NULL,
  customer_id uuid,
  party_count integer NOT NULL CHECK (party_count>0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  hold_expires_at timestamptz,
  status text NOT NULL DEFAULT 'HOLD' CHECK (status IN ('HOLD', 'PAYMENT_PENDING', 'APPROVAL_PENDING', 'CONFIRMED', 'CANCELED', 'NO_SHOW', 'PAYMENT_EXCEPTION')),
  admission_pricing text NOT NULL CHECK (admission_pricing IN ('INCLUDED', 'SEPARATE')),
  minimum_minor bigint NOT NULL CHECK (minimum_minor>=0),
  deposit_minor bigint NOT NULL CHECK (deposit_minor>=0),
  currency char(3) NOT NULL,
  policy_snapshot jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, event_id, visit_id, id),
  CHECK (ends_at>starts_at)
);
COMMENT ON TABLE nightclub.bookings IS 'VIP予約。入場許可・決済とは独立。';

CREATE TABLE nightclub.booking_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  booking_version integer NOT NULL CHECK (booking_version>0),
  actor_membership_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, event_id, booking_id, booking_version)
);
COMMENT ON TABLE nightclub.booking_decisions IS '店舗予約ルールが手動承認の場合の判断。フリー承認と別。';

CREATE TABLE nightclub.table_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  table_id uuid NOT NULL,
  occupied_during tstzrange NOT NULL,
  status text NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD', 'CONFIRMED', 'RELEASED')),
  expires_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  CHECK (NOT isempty(occupied_during) AND NOT lower_inf(occupied_during) AND NOT upper_inf(occupied_during) AND lower_inc(occupied_during) AND NOT upper_inc(occupied_during))
);
COMMENT ON TABLE nightclub.table_allocations IS '準備時間を含む物理テーブル占有。期限経過は明示的に解放。';

CREATE TABLE nightclub.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ADMISSION', 'VIP', 'IN_VENUE')),
  visit_id uuid NOT NULL,
  booking_id uuid,
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'FINALIZED', 'ADJUSTED', 'VOID')),
  external_system text,
  external_order_id text,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, external_system, external_order_id),
  UNIQUE (tenant_id, store_id, event_id, id, currency)
);
COMMENT ON TABLE nightclub.sales_orders IS '来店・VIP会計。事前預りを売上行にしない。';

CREATE TABLE nightclub.sales_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  order_id uuid NOT NULL,
  segment_id uuid,
  category text NOT NULL CHECK (category IN ('ADMISSION', 'VIP', 'IN_VENUE', 'CANCELLATION', 'REENTRY')),
  line_kind text NOT NULL CHECK (line_kind IN ('SALE', 'CREDIT')),
  description text NOT NULL,
  quantity integer NOT NULL CHECK (quantity>0),
  gross_minor bigint NOT NULL,
  tax_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  adjusts_line_id uuid,
  source_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, source_key),
  UNIQUE (tenant_id, store_id, event_id, order_id, id, currency),
  CHECK ((line_kind='SALE' AND gross_minor>=0 AND tax_minor>=0) OR (line_kind='CREDIT' AND gross_minor<=0 AND tax_minor<=0 AND adjusts_line_id IS NOT NULL)),
  CHECK (abs(tax_minor)<=abs(gross_minor))
);
COMMENT ON TABLE nightclub.sales_lines IS '確定した利用明細。業務売上と法定会計の認識は別。';

CREATE TABLE nightclub.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  recorded_by uuid,
  operator_session_id uuid,
  order_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('CASH', 'EXTERNAL_TERMINAL', 'PSP')),
  purpose text NOT NULL CHECK (purpose IN ('DEPOSIT', 'FINAL', 'ADMISSION')),
  amount_minor bigint NOT NULL CHECK (amount_minor>0),
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'PARTIAL_REFUND', 'REFUNDED', 'DISPUTED')),
  provider text,
  provider_account text,
  provider_reference text,
  operation_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, operation_id),
  UNIQUE (provider, provider_account, provider_reference),
  UNIQUE (tenant_id, store_id, event_id, id, currency)
);
COMMENT ON TABLE nightclub.payments IS '入金と預り。決済回数と売上額を分離。';

CREATE TABLE nightclub.payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  sales_line_id uuid,
  payment_id uuid NOT NULL,
  order_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor<>0),
  currency char(3) NOT NULL,
  reverses_id uuid,
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, operation_id),
  CHECK (amount_minor>0 OR reverses_id IS NOT NULL)
);
COMMENT ON TABLE nightclub.payment_allocations IS '支払・預りを会計・売上行に充当。返金の解除は符号付き調整。';

CREATE TABLE nightclub.refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor>0),
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'PROCESSING', 'SUCCEEDED', 'FAILED')),
  reason text NOT NULL,
  requested_by uuid NOT NULL,
  provider_reference text,
  operation_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, operation_id)
);
COMMENT ON TABLE nightclub.refunds IS '返金指示と外部結果。売上取消・割当解除は別取引で関連付け。';

CREATE TABLE nightclub.payment_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  provider_reference text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor>0),
  status text NOT NULL CHECK (status IN ('OPEN', 'WON', 'LOST', 'CLOSED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, provider_reference)
);
COMMENT ON TABLE nightclub.payment_disputes IS 'チャージバック・調査と報酬調整の根拠。';

CREATE TABLE nightclub.coupon_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  coupon_id uuid NOT NULL,
  visit_id uuid NOT NULL,
  sales_line_id uuid,
  status text NOT NULL CHECK (status IN ('HELD', 'CONSUMED', 'RELEASED')),
  operation_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, operation_id)
);
COMMENT ON TABLE nightclub.coupon_redemptions IS 'クーポンの確定引当と使用・取消。';

CREATE TABLE nightclub.sales_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  sales_line_id uuid NOT NULL,
  referrer_membership_id uuid NOT NULL,
  basis_points integer NOT NULL CHECK (basis_points BETWEEN 1 AND 10000),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, event_id, sales_line_id, referrer_membership_id, version)
);
COMMENT ON TABLE nightclub.sales_attributions IS '売上行の帰属。R1は主紹介者100%。';

CREATE TABLE nightclub.reward_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  rule_key uuid NOT NULL,
  version integer NOT NULL CHECK (version>0),
  referrer_membership_id uuid,
  conditions jsonb NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, rule_key, version),
  CHECK (valid_to>valid_from)
);
COMMENT ON TABLE nightclub.reward_rules IS '報酬契約版。単価・率・丸め・除外条件。';

CREATE TABLE nightclub.settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  version integer NOT NULL CHECK (version>0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'RECONCILING', 'FINALIZED')),
  finalized_by uuid,
  finalized_at timestamptz,
  exception_note text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, event_id, version)
);
COMMENT ON TABLE nightclub.settlements IS '営業と報酬の締め版。確定後上書きしない。';

CREATE TABLE nightclub.settlement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  referrer_membership_id uuid NOT NULL,
  reward_rule_id uuid NOT NULL,
  admission_event_id uuid,
  sales_line_id uuid,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  calculation jsonb NOT NULL,
  source_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, event_id, settlement_id, source_key),
  CHECK (num_nonnulls(admission_event_id,sales_line_id)=1)
);
COMMENT ON TABLE nightclub.settlement_lines IS '計算根拠へ遡れる紹介者別明細。';

CREATE TABLE nightclub.reward_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  settlement_line_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor<>0),
  reason text NOT NULL,
  created_by uuid NOT NULL,
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, operation_id)
);
COMMENT ON TABLE nightclub.reward_adjustments IS '締め後調整。元明細と理由を保存。';

CREATE TABLE nightclub.reward_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  settlement_line_id uuid NOT NULL,
  raised_by uuid NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'REJECTED')),
  resolution text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id)
);
COMMENT ON TABLE nightclub.reward_disputes IS '紹介者の報酬異議。';

CREATE TABLE nightclub.settlement_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  referrer_membership_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor>0),
  currency char(3) NOT NULL,
  external_reference text NOT NULL,
  recorded_by uuid NOT NULL,
  paid_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, external_reference)
);
COMMENT ON TABLE nightclub.settlement_payments IS '外部で実施した報酬支払記録。銀行送金実行は含まない。';

CREATE TABLE nightclub.cash_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  operator_session_id uuid NOT NULL,
  opening_minor bigint NOT NULL CHECK (opening_minor>=0),
  counted_minor bigint CHECK (counted_minor IS NULL OR counted_minor>=0),
  closed_at timestamptz,
  difference_note text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id)
);
COMMENT ON TABLE nightclub.cash_sessions IS '入口シフト現金照合。';

CREATE TABLE nightclub.command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
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
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, actor_key, operation_name, operation_key)
);
COMMENT ON TABLE nightclub.command_receipts IS '書込冪等キー・正規化リクエストハッシュ・再送結果。';

CREATE TABLE nightclub.event_stream_heads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq>=0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, event_id)
);
COMMENT ON TABLE nightclub.event_stream_heads IS '営業ごとのコミット順序用カウンタ。sequenceを使わない。';

CREATE TABLE nightclub.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  stream_seq bigint NOT NULL CHECK (stream_seq>0),
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version>0),
  payload jsonb NOT NULL,
  trace_id uuid NOT NULL,
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, event_id, stream_seq)
);
COMMENT ON TABLE nightclub.outbox_events IS 'DB更新と同時保存。配送は重複し得る。';

CREATE TABLE nightclub.sync_acks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  device_id uuid NOT NULL,
  operator_session_id uuid NOT NULL,
  applied_seq bigint NOT NULL CHECK (applied_seq>=0),
  snapshot_token_hash text NOT NULL,
  last_seen_at timestamptz NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('FOREGROUND', 'BACKGROUND')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, event_id, device_id)
);
COMMENT ON TABLE nightclub.sync_acks IS '入口端末ごとの適用済みストリーム位置。既読ではない。';

CREATE TABLE nightclub.notification_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  template_key text NOT NULL,
  locale text NOT NULL,
  version integer NOT NULL CHECK (version>0),
  body text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, template_key, locale, version)
);
COMMENT ON TABLE nightclub.notification_templates IS '通知文言とローカライズ。';

CREATE TABLE nightclub.notification_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL,
  outbox_event_id uuid,
  recipient_membership_id uuid,
  recipient_customer_id uuid,
  channel text NOT NULL CHECK (channel IN ('IN_APP', 'PUSH', 'EMAIL', 'LINE', 'SMS')),
  dedup_key text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'SENT', 'FAILED', 'SUPPRESSED')),
  scheduled_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  provider_reference text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, event_id, id),
  UNIQUE (tenant_id, store_id, dedup_key),
  CHECK (num_nonnulls(recipient_membership_id,recipient_customer_id)=1)
);
COMMENT ON TABLE nightclub.notification_jobs IS '通知・再送。外部連絡先は最小化。';

CREATE TABLE nightclub.integration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  provider text NOT NULL,
  provider_account text NOT NULL,
  external_event_id text NOT NULL,
  payload_hash text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  error_code text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (provider, provider_account, external_event_id)
);
COMMENT ON TABLE nightclub.integration_events IS '署名検証済みWebhook・CSV受領。再送と順序逆転を照合。';

CREATE TABLE nightclub.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  actor_membership_id uuid,
  device_id uuid,
  operator_session_id uuid,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  before_version integer,
  after_version integer,
  changes jsonb NOT NULL,
  reason text,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id)
);
COMMENT ON TABLE nightclub.audit_logs IS '通常利用者が変更しない監査。保持・匿名化は別の管理手順。';

CREATE TABLE nightclub.export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  report_kind text NOT NULL,
  filters jsonb NOT NULL,
  format text NOT NULL CHECK (format IN ('CSV', 'XLSX', 'PDF')),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED')),
  object_key text,
  expires_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id)
);
COMMENT ON TABLE nightclub.export_jobs IS '帳票生成と権限付き短期成果物。';

CREATE TABLE nightclub.import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  source_system text NOT NULL,
  file_hash text NOT NULL,
  status text NOT NULL DEFAULT 'UPLOADED' CHECK (status IN ('UPLOADED', 'VALIDATED', 'APPLYING', 'COMPLETED', 'FAILED')),
  mapping jsonb NOT NULL,
  validation_errors jsonb NOT NULL,
  operation_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, operation_id)
);
COMMENT ON TABLE nightclub.import_jobs IS '移行ファイルの試行取込・検証・本反映。';
ALTER TABLE nightclub.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.tenants FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.tenants FROM PUBLIC;
ALTER TABLE nightclub.app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.app_users FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.app_users FROM PUBLIC;
ALTER TABLE nightclub.external_identities ADD CONSTRAINT fk_external_identities_1 FOREIGN KEY (user_id) REFERENCES nightclub.app_users (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.external_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.external_identities FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.external_identities FROM PUBLIC;
ALTER TABLE nightclub.auth_sessions ADD CONSTRAINT fk_auth_sessions_1 FOREIGN KEY (user_id) REFERENCES nightclub.app_users (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.auth_sessions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.auth_sessions FROM PUBLIC;
ALTER TABLE nightclub.stores ADD CONSTRAINT fk_stores_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.stores FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.stores FROM PUBLIC;
ALTER TABLE nightclub.memberships ADD CONSTRAINT fk_memberships_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.memberships ADD CONSTRAINT fk_memberships_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.memberships ADD CONSTRAINT fk_memberships_3 FOREIGN KEY (user_id) REFERENCES nightclub.app_users (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.memberships FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.memberships FROM PUBLIC;
ALTER TABLE nightclub.roles ADD CONSTRAINT fk_roles_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.roles ADD CONSTRAINT fk_roles_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.roles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.roles FROM PUBLIC;
ALTER TABLE nightclub.role_permissions ADD CONSTRAINT fk_role_permissions_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.role_permissions ADD CONSTRAINT fk_role_permissions_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.role_permissions ADD CONSTRAINT fk_role_permissions_3 FOREIGN KEY (tenant_id, store_id, role_id) REFERENCES nightclub.roles (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.role_permissions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.role_permissions FROM PUBLIC;
ALTER TABLE nightclub.membership_roles ADD CONSTRAINT fk_membership_roles_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.membership_roles ADD CONSTRAINT fk_membership_roles_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.membership_roles ADD CONSTRAINT fk_membership_roles_3 FOREIGN KEY (tenant_id, store_id, membership_id) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.membership_roles ADD CONSTRAINT fk_membership_roles_4 FOREIGN KEY (tenant_id, store_id, role_id) REFERENCES nightclub.roles (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.membership_roles ADD CONSTRAINT fk_membership_roles_5 FOREIGN KEY (tenant_id, store_id, granted_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.membership_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.membership_roles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.membership_roles FROM PUBLIC;
ALTER TABLE nightclub.invitation_tokens ADD CONSTRAINT fk_invitation_tokens_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.invitation_tokens ADD CONSTRAINT fk_invitation_tokens_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.invitation_tokens ADD CONSTRAINT fk_invitation_tokens_3 FOREIGN KEY (tenant_id, store_id, role_id) REFERENCES nightclub.roles (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.invitation_tokens ADD CONSTRAINT fk_invitation_tokens_4 FOREIGN KEY (tenant_id, store_id, issued_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.invitation_tokens ADD CONSTRAINT fk_invitation_tokens_5 FOREIGN KEY (used_by) REFERENCES nightclub.app_users (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.invitation_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.invitation_tokens FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.invitation_tokens FROM PUBLIC;
ALTER TABLE nightclub.events ADD CONSTRAINT fk_events_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.events ADD CONSTRAINT fk_events_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.events FROM PUBLIC;
ALTER TABLE nightclub.event_assignments ADD CONSTRAINT fk_event_assignments_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.event_assignments ADD CONSTRAINT fk_event_assignments_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.event_assignments ADD CONSTRAINT fk_event_assignments_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.event_assignments ADD CONSTRAINT fk_event_assignments_4 FOREIGN KEY (tenant_id, store_id, membership_id) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.event_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.event_assignments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.event_assignments FROM PUBLIC;
ALTER TABLE nightclub.devices ADD CONSTRAINT fk_devices_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.devices ADD CONSTRAINT fk_devices_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.devices ADD CONSTRAINT fk_devices_3 FOREIGN KEY (tenant_id, store_id, enrolled_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.devices FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.devices FROM PUBLIC;
ALTER TABLE nightclub.device_enrollments ADD CONSTRAINT fk_device_enrollments_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.device_enrollments ADD CONSTRAINT fk_device_enrollments_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.device_enrollments ADD CONSTRAINT fk_device_enrollments_3 FOREIGN KEY (tenant_id, store_id, device_id) REFERENCES nightclub.devices (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.device_enrollments ADD CONSTRAINT fk_device_enrollments_4 FOREIGN KEY (tenant_id, store_id, issued_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.device_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.device_enrollments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.device_enrollments FROM PUBLIC;
ALTER TABLE nightclub.device_sessions ADD CONSTRAINT fk_device_sessions_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.device_sessions ADD CONSTRAINT fk_device_sessions_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.device_sessions ADD CONSTRAINT fk_device_sessions_3 FOREIGN KEY (tenant_id, store_id, device_id) REFERENCES nightclub.devices (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.device_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.device_sessions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.device_sessions FROM PUBLIC;
ALTER TABLE nightclub.operator_credentials ADD CONSTRAINT fk_operator_credentials_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.operator_credentials ADD CONSTRAINT fk_operator_credentials_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.operator_credentials ADD CONSTRAINT fk_operator_credentials_3 FOREIGN KEY (tenant_id, store_id, membership_id) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.operator_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.operator_credentials FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.operator_credentials FROM PUBLIC;
ALTER TABLE nightclub.operator_sessions ADD CONSTRAINT fk_operator_sessions_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.operator_sessions ADD CONSTRAINT fk_operator_sessions_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.operator_sessions ADD CONSTRAINT fk_operator_sessions_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.operator_sessions ADD CONSTRAINT fk_operator_sessions_4 FOREIGN KEY (tenant_id, store_id, device_id) REFERENCES nightclub.devices (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.operator_sessions ADD CONSTRAINT fk_operator_sessions_5 FOREIGN KEY (tenant_id, store_id, device_session_id) REFERENCES nightclub.device_sessions (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.operator_sessions ADD CONSTRAINT fk_operator_sessions_6 FOREIGN KEY (tenant_id, store_id, membership_id) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.operator_sessions ADD CONSTRAINT fk_operator_sessions_7 FOREIGN KEY (tenant_id, store_id, device_id, device_session_id) REFERENCES nightclub.device_sessions (tenant_id, store_id, device_id, id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX one_operator_per_device ON nightclub.operator_sessions (tenant_id,store_id,device_id) WHERE ended_at IS NULL;
ALTER TABLE nightclub.operator_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.operator_sessions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.operator_sessions FROM PUBLIC;
ALTER TABLE nightclub.customers ADD CONSTRAINT fk_customers_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.customers ADD CONSTRAINT fk_customers_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
CREATE INDEX customer_name_search ON nightclub.customers (tenant_id,store_id,name_key text_pattern_ops);
ALTER TABLE nightclub.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.customers FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.customers FROM PUBLIC;
ALTER TABLE nightclub.customer_aliases ADD CONSTRAINT fk_customer_aliases_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.customer_aliases ADD CONSTRAINT fk_customer_aliases_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.customer_aliases ADD CONSTRAINT fk_customer_aliases_3 FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES nightclub.customers (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.customer_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.customer_aliases FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.customer_aliases FROM PUBLIC;
ALTER TABLE nightclub.operating_templates ADD CONSTRAINT fk_operating_templates_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.operating_templates ADD CONSTRAINT fk_operating_templates_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.operating_templates ADD CONSTRAINT fk_operating_templates_3 FOREIGN KEY (tenant_id, store_id, created_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.operating_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.operating_templates FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.operating_templates FROM PUBLIC;
ALTER TABLE nightclub.policy_versions ADD CONSTRAINT fk_policy_versions_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.policy_versions ADD CONSTRAINT fk_policy_versions_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.policy_versions ADD CONSTRAINT fk_policy_versions_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.policy_versions ADD CONSTRAINT fk_policy_versions_4 FOREIGN KEY (tenant_id, store_id, published_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.policy_versions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.policy_versions FROM PUBLIC;
ALTER TABLE nightclub.price_rules ADD CONSTRAINT fk_price_rules_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.price_rules ADD CONSTRAINT fk_price_rules_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.price_rules ADD CONSTRAINT fk_price_rules_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.price_rules ADD CONSTRAINT fk_price_rules_4 FOREIGN KEY (tenant_id, store_id, event_id, policy_version_id) REFERENCES nightclub.policy_versions (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.price_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.price_rules FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.price_rules FROM PUBLIC;
ALTER TABLE nightclub.permits ADD CONSTRAINT fk_permits_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.permits ADD CONSTRAINT fk_permits_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.permits ADD CONSTRAINT fk_permits_3 FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES nightclub.customers (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.permits ADD CONSTRAINT fk_permits_4 FOREIGN KEY (tenant_id, store_id, actor_membership_id) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.permits ADD CONSTRAINT fk_permits_5 FOREIGN KEY (tenant_id, store_id, granted_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.permits ADD CONSTRAINT fk_permits_6 FOREIGN KEY (tenant_id, store_id, supersedes_id) REFERENCES nightclub.permits (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.permits FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.permits FROM PUBLIC;
ALTER TABLE nightclub.referrer_profiles ADD CONSTRAINT fk_referrer_profiles_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.referrer_profiles ADD CONSTRAINT fk_referrer_profiles_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.referrer_profiles ADD CONSTRAINT fk_referrer_profiles_3 FOREIGN KEY (tenant_id, store_id, membership_id) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.referrer_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.referrer_profiles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.referrer_profiles FROM PUBLIC;
ALTER TABLE nightclub.invitation_links ADD CONSTRAINT fk_invitation_links_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.invitation_links ADD CONSTRAINT fk_invitation_links_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.invitation_links ADD CONSTRAINT fk_invitation_links_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.invitation_links ADD CONSTRAINT fk_invitation_links_4 FOREIGN KEY (tenant_id, store_id, referrer_membership_id) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.invitation_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.invitation_links FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.invitation_links FROM PUBLIC;
ALTER TABLE nightclub.coupons ADD CONSTRAINT fk_coupons_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.coupons ADD CONSTRAINT fk_coupons_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.coupons ADD CONSTRAINT fk_coupons_3 FOREIGN KEY (tenant_id, store_id, owner_membership_id) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.coupons FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.coupons FROM PUBLIC;
ALTER TABLE nightclub.visits ADD CONSTRAINT fk_visits_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.visits ADD CONSTRAINT fk_visits_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.visits ADD CONSTRAINT fk_visits_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.visits ADD CONSTRAINT fk_visits_4 FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES nightclub.customers (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.visits ADD CONSTRAINT fk_visits_5 FOREIGN KEY (tenant_id, store_id, referrer_membership_id) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.visits ADD CONSTRAINT fk_visits_6 FOREIGN KEY (tenant_id, store_id, created_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
CREATE INDEX visit_name_search ON nightclub.visits (tenant_id,store_id,event_id,name_key text_pattern_ops);
ALTER TABLE nightclub.visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.visits FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.visits FROM PUBLIC;
ALTER TABLE nightclub.visit_members ADD CONSTRAINT fk_visit_members_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.visit_members ADD CONSTRAINT fk_visit_members_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.visit_members ADD CONSTRAINT fk_visit_members_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.visit_members ADD CONSTRAINT fk_visit_members_4 FOREIGN KEY (tenant_id, store_id, event_id, visit_id) REFERENCES nightclub.visits (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.visit_members ADD CONSTRAINT fk_visit_members_5 FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES nightclub.customers (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.visit_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.visit_members FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.visit_members FROM PUBLIC;
ALTER TABLE nightclub.customer_checks ADD CONSTRAINT fk_customer_checks_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.customer_checks ADD CONSTRAINT fk_customer_checks_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.customer_checks ADD CONSTRAINT fk_customer_checks_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.customer_checks ADD CONSTRAINT fk_customer_checks_4 FOREIGN KEY (tenant_id, store_id, event_id, visit_id) REFERENCES nightclub.visits (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.customer_checks ADD CONSTRAINT fk_customer_checks_5 FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES nightclub.customers (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.customer_checks ADD CONSTRAINT fk_customer_checks_6 FOREIGN KEY (tenant_id, store_id, checked_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.customer_checks ADD CONSTRAINT fk_customer_checks_7 FOREIGN KEY (tenant_id, store_id, event_id, operator_session_id) REFERENCES nightclub.operator_sessions (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.customer_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.customer_checks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.customer_checks FROM PUBLIC;
ALTER TABLE nightclub.admission_segments ADD CONSTRAINT fk_admission_segments_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_segments ADD CONSTRAINT fk_admission_segments_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_segments ADD CONSTRAINT fk_admission_segments_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_segments ADD CONSTRAINT fk_admission_segments_4 FOREIGN KEY (tenant_id, store_id, event_id, visit_id) REFERENCES nightclub.visits (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_segments ADD CONSTRAINT fk_admission_segments_5 FOREIGN KEY (tenant_id, store_id, event_id, price_rule_id) REFERENCES nightclub.price_rules (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_segments ADD CONSTRAINT fk_admission_segments_6 FOREIGN KEY (tenant_id, store_id, permit_id) REFERENCES nightclub.permits (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_segments ADD CONSTRAINT fk_admission_segments_7 FOREIGN KEY (tenant_id, store_id, required_customer_id) REFERENCES nightclub.customers (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.admission_segments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.admission_segments FROM PUBLIC;
ALTER TABLE nightclub.approval_requests ADD CONSTRAINT fk_approval_requests_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.approval_requests ADD CONSTRAINT fk_approval_requests_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.approval_requests ADD CONSTRAINT fk_approval_requests_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.approval_requests ADD CONSTRAINT fk_approval_requests_4 FOREIGN KEY (tenant_id, store_id, event_id, segment_id) REFERENCES nightclub.admission_segments (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.approval_requests ADD CONSTRAINT fk_approval_requests_5 FOREIGN KEY (tenant_id, store_id, requested_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX one_pending_request ON nightclub.approval_requests (tenant_id,store_id,event_id,segment_id) WHERE status='PENDING';
ALTER TABLE nightclub.approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.approval_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.approval_requests FROM PUBLIC;
ALTER TABLE nightclub.approval_decisions ADD CONSTRAINT fk_approval_decisions_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.approval_decisions ADD CONSTRAINT fk_approval_decisions_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.approval_decisions ADD CONSTRAINT fk_approval_decisions_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.approval_decisions ADD CONSTRAINT fk_approval_decisions_4 FOREIGN KEY (tenant_id, store_id, event_id, request_id) REFERENCES nightclub.approval_requests (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.approval_decisions ADD CONSTRAINT fk_approval_decisions_5 FOREIGN KEY (tenant_id, store_id, decided_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.approval_decisions ADD CONSTRAINT fk_approval_decisions_6 FOREIGN KEY (tenant_id, store_id, event_id, operator_session_id) REFERENCES nightclub.operator_sessions (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.approval_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.approval_decisions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.approval_decisions FROM PUBLIC;
ALTER TABLE nightclub.quota_buckets ADD CONSTRAINT fk_quota_buckets_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.quota_buckets ADD CONSTRAINT fk_quota_buckets_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.quota_buckets ADD CONSTRAINT fk_quota_buckets_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.quota_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.quota_buckets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.quota_buckets FROM PUBLIC;
ALTER TABLE nightclub.quota_allocations ADD CONSTRAINT fk_quota_allocations_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.quota_allocations ADD CONSTRAINT fk_quota_allocations_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.quota_allocations ADD CONSTRAINT fk_quota_allocations_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.quota_allocations ADD CONSTRAINT fk_quota_allocations_4 FOREIGN KEY (tenant_id, store_id, event_id, bucket_id) REFERENCES nightclub.quota_buckets (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.quota_allocations ADD CONSTRAINT fk_quota_allocations_5 FOREIGN KEY (tenant_id, store_id, event_id, segment_id) REFERENCES nightclub.admission_segments (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.quota_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.quota_allocations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.quota_allocations FROM PUBLIC;
ALTER TABLE nightclub.entry_passes ADD CONSTRAINT fk_entry_passes_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.entry_passes ADD CONSTRAINT fk_entry_passes_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.entry_passes ADD CONSTRAINT fk_entry_passes_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.entry_passes ADD CONSTRAINT fk_entry_passes_4 FOREIGN KEY (tenant_id, store_id, event_id, visit_id) REFERENCES nightclub.visits (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.entry_passes ADD CONSTRAINT fk_entry_passes_5 FOREIGN KEY (tenant_id, store_id, event_id, member_id) REFERENCES nightclub.visit_members (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.entry_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.entry_passes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.entry_passes FROM PUBLIC;
ALTER TABLE nightclub.admission_events ADD CONSTRAINT fk_admission_events_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_events ADD CONSTRAINT fk_admission_events_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_events ADD CONSTRAINT fk_admission_events_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_events ADD CONSTRAINT fk_admission_events_4 FOREIGN KEY (tenant_id, store_id, event_id, visit_id) REFERENCES nightclub.visits (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_events ADD CONSTRAINT fk_admission_events_5 FOREIGN KEY (tenant_id, store_id, event_id, segment_id) REFERENCES nightclub.admission_segments (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_events ADD CONSTRAINT fk_admission_events_6 FOREIGN KEY (tenant_id, store_id, event_id, pass_id) REFERENCES nightclub.entry_passes (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_events ADD CONSTRAINT fk_admission_events_7 FOREIGN KEY (tenant_id, store_id, event_id, operator_session_id) REFERENCES nightclub.operator_sessions (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_events ADD CONSTRAINT fk_admission_events_8 FOREIGN KEY (tenant_id, store_id, actor_membership_id) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_events ADD CONSTRAINT fk_admission_events_9 FOREIGN KEY (tenant_id, store_id, event_id, customer_check_id) REFERENCES nightclub.customer_checks (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_events ADD CONSTRAINT fk_admission_events_10 FOREIGN KEY (tenant_id, store_id, event_id, corrects_id) REFERENCES nightclub.admission_events (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_events ADD CONSTRAINT fk_admission_events_11 FOREIGN KEY (tenant_id, store_id, event_id, visit_id, segment_id) REFERENCES nightclub.admission_segments (tenant_id, store_id, event_id, visit_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_events ADD CONSTRAINT fk_admission_events_12 FOREIGN KEY (tenant_id, store_id, event_id, visit_id, pass_id) REFERENCES nightclub.entry_passes (tenant_id, store_id, event_id, visit_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_events ADD CONSTRAINT fk_admission_events_13 FOREIGN KEY (tenant_id, store_id, event_id, visit_id, customer_check_id) REFERENCES nightclub.customer_checks (tenant_id, store_id, event_id, visit_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.admission_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.admission_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.admission_events FROM PUBLIC;
ALTER TABLE nightclub.provisional_entries ADD CONSTRAINT fk_provisional_entries_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.provisional_entries ADD CONSTRAINT fk_provisional_entries_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.provisional_entries ADD CONSTRAINT fk_provisional_entries_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.provisional_entries ADD CONSTRAINT fk_provisional_entries_4 FOREIGN KEY (tenant_id, store_id, device_id) REFERENCES nightclub.devices (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.provisional_entries ADD CONSTRAINT fk_provisional_entries_5 FOREIGN KEY (tenant_id, store_id, actor_membership_id) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.provisional_entries ADD CONSTRAINT fk_provisional_entries_6 FOREIGN KEY (tenant_id, store_id, event_id, visit_id) REFERENCES nightclub.visits (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.provisional_entries ADD CONSTRAINT fk_provisional_entries_7 FOREIGN KEY (tenant_id, store_id, event_id, reconciled_entry_id) REFERENCES nightclub.admission_events (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.provisional_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.provisional_entries FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.provisional_entries FROM PUBLIC;
ALTER TABLE nightclub.floor_maps ADD CONSTRAINT fk_floor_maps_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.floor_maps ADD CONSTRAINT fk_floor_maps_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.floor_maps ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.floor_maps FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.floor_maps FROM PUBLIC;
ALTER TABLE nightclub.venue_tables ADD CONSTRAINT fk_venue_tables_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.venue_tables ADD CONSTRAINT fk_venue_tables_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.venue_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.venue_tables FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.venue_tables FROM PUBLIC;
ALTER TABLE nightclub.bookings ADD CONSTRAINT fk_bookings_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.bookings ADD CONSTRAINT fk_bookings_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.bookings ADD CONSTRAINT fk_bookings_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.bookings ADD CONSTRAINT fk_bookings_4 FOREIGN KEY (tenant_id, store_id, event_id, visit_id) REFERENCES nightclub.visits (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.bookings ADD CONSTRAINT fk_bookings_5 FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES nightclub.customers (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.bookings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.bookings FROM PUBLIC;
ALTER TABLE nightclub.booking_decisions ADD CONSTRAINT fk_booking_decisions_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.booking_decisions ADD CONSTRAINT fk_booking_decisions_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.booking_decisions ADD CONSTRAINT fk_booking_decisions_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.booking_decisions ADD CONSTRAINT fk_booking_decisions_4 FOREIGN KEY (tenant_id, store_id, event_id, booking_id) REFERENCES nightclub.bookings (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.booking_decisions ADD CONSTRAINT fk_booking_decisions_5 FOREIGN KEY (tenant_id, store_id, actor_membership_id) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.booking_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.booking_decisions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.booking_decisions FROM PUBLIC;
ALTER TABLE nightclub.table_allocations ADD CONSTRAINT fk_table_allocations_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.table_allocations ADD CONSTRAINT fk_table_allocations_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.table_allocations ADD CONSTRAINT fk_table_allocations_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.table_allocations ADD CONSTRAINT fk_table_allocations_4 FOREIGN KEY (tenant_id, store_id, event_id, booking_id) REFERENCES nightclub.bookings (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.table_allocations ADD CONSTRAINT fk_table_allocations_5 FOREIGN KEY (tenant_id, store_id, table_id) REFERENCES nightclub.venue_tables (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.table_allocations ADD CONSTRAINT no_table_overlap EXCLUDE USING gist (tenant_id WITH =, store_id WITH =, table_id WITH =, occupied_during WITH &&) WHERE (status IN ('HELD','CONFIRMED'));
ALTER TABLE nightclub.table_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.table_allocations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.table_allocations FROM PUBLIC;
ALTER TABLE nightclub.sales_orders ADD CONSTRAINT fk_sales_orders_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sales_orders ADD CONSTRAINT fk_sales_orders_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sales_orders ADD CONSTRAINT fk_sales_orders_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sales_orders ADD CONSTRAINT fk_sales_orders_4 FOREIGN KEY (tenant_id, store_id, event_id, visit_id) REFERENCES nightclub.visits (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sales_orders ADD CONSTRAINT fk_sales_orders_5 FOREIGN KEY (tenant_id, store_id, event_id, booking_id) REFERENCES nightclub.bookings (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sales_orders ADD CONSTRAINT fk_sales_orders_6 FOREIGN KEY (tenant_id, store_id, event_id, visit_id, booking_id) REFERENCES nightclub.bookings (tenant_id, store_id, event_id, visit_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.sales_orders FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.sales_orders FROM PUBLIC;
ALTER TABLE nightclub.sales_lines ADD CONSTRAINT fk_sales_lines_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sales_lines ADD CONSTRAINT fk_sales_lines_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sales_lines ADD CONSTRAINT fk_sales_lines_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sales_lines ADD CONSTRAINT fk_sales_lines_4 FOREIGN KEY (tenant_id, store_id, event_id, order_id) REFERENCES nightclub.sales_orders (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sales_lines ADD CONSTRAINT fk_sales_lines_5 FOREIGN KEY (tenant_id, store_id, event_id, segment_id) REFERENCES nightclub.admission_segments (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sales_lines ADD CONSTRAINT fk_sales_lines_6 FOREIGN KEY (tenant_id, store_id, event_id, adjusts_line_id) REFERENCES nightclub.sales_lines (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sales_lines ADD CONSTRAINT fk_sales_lines_7 FOREIGN KEY (tenant_id, store_id, event_id, order_id, currency) REFERENCES nightclub.sales_orders (tenant_id, store_id, event_id, id, currency) ON DELETE RESTRICT;
ALTER TABLE nightclub.sales_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.sales_lines FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.sales_lines FROM PUBLIC;
ALTER TABLE nightclub.payments ADD CONSTRAINT fk_payments_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.payments ADD CONSTRAINT fk_payments_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.payments ADD CONSTRAINT fk_payments_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.payments ADD CONSTRAINT fk_payments_4 FOREIGN KEY (tenant_id, store_id, recorded_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.payments ADD CONSTRAINT fk_payments_5 FOREIGN KEY (tenant_id, store_id, event_id, operator_session_id) REFERENCES nightclub.operator_sessions (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.payments ADD CONSTRAINT fk_payments_6 FOREIGN KEY (tenant_id, store_id, event_id, order_id) REFERENCES nightclub.sales_orders (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.payments ADD CONSTRAINT fk_payments_7 FOREIGN KEY (tenant_id, store_id, event_id, order_id, currency) REFERENCES nightclub.sales_orders (tenant_id, store_id, event_id, id, currency) ON DELETE RESTRICT;
ALTER TABLE nightclub.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.payments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.payments FROM PUBLIC;
ALTER TABLE nightclub.payment_allocations ADD CONSTRAINT fk_payment_allocations_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.payment_allocations ADD CONSTRAINT fk_payment_allocations_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.payment_allocations ADD CONSTRAINT fk_payment_allocations_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.payment_allocations ADD CONSTRAINT fk_payment_allocations_4 FOREIGN KEY (tenant_id, store_id, event_id, sales_line_id) REFERENCES nightclub.sales_lines (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.payment_allocations ADD CONSTRAINT fk_payment_allocations_5 FOREIGN KEY (tenant_id, store_id, event_id, payment_id) REFERENCES nightclub.payments (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.payment_allocations ADD CONSTRAINT fk_payment_allocations_6 FOREIGN KEY (tenant_id, store_id, event_id, order_id) REFERENCES nightclub.sales_orders (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.payment_allocations ADD CONSTRAINT fk_payment_allocations_7 FOREIGN KEY (tenant_id, store_id, event_id, reverses_id) REFERENCES nightclub.payment_allocations (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.payment_allocations ADD CONSTRAINT fk_payment_allocations_8 FOREIGN KEY (tenant_id, store_id, event_id, order_id, currency) REFERENCES nightclub.sales_orders (tenant_id, store_id, event_id, id, currency) ON DELETE RESTRICT;
ALTER TABLE nightclub.payment_allocations ADD CONSTRAINT fk_payment_allocations_9 FOREIGN KEY (tenant_id, store_id, event_id, payment_id, currency) REFERENCES nightclub.payments (tenant_id, store_id, event_id, id, currency) ON DELETE RESTRICT;
ALTER TABLE nightclub.payment_allocations ADD CONSTRAINT fk_payment_allocations_10 FOREIGN KEY (tenant_id, store_id, event_id, order_id, sales_line_id, currency) REFERENCES nightclub.sales_lines (tenant_id, store_id, event_id, order_id, id, currency) ON DELETE RESTRICT;
ALTER TABLE nightclub.payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.payment_allocations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.payment_allocations FROM PUBLIC;
ALTER TABLE nightclub.refunds ADD CONSTRAINT fk_refunds_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.refunds ADD CONSTRAINT fk_refunds_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.refunds ADD CONSTRAINT fk_refunds_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.refunds ADD CONSTRAINT fk_refunds_4 FOREIGN KEY (tenant_id, store_id, event_id, payment_id) REFERENCES nightclub.payments (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.refunds ADD CONSTRAINT fk_refunds_5 FOREIGN KEY (tenant_id, store_id, requested_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.refunds ADD CONSTRAINT fk_refunds_6 FOREIGN KEY (tenant_id, store_id, event_id, payment_id, currency) REFERENCES nightclub.payments (tenant_id, store_id, event_id, id, currency) ON DELETE RESTRICT;
ALTER TABLE nightclub.refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.refunds FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.refunds FROM PUBLIC;
ALTER TABLE nightclub.payment_disputes ADD CONSTRAINT fk_payment_disputes_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.payment_disputes ADD CONSTRAINT fk_payment_disputes_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.payment_disputes ADD CONSTRAINT fk_payment_disputes_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.payment_disputes ADD CONSTRAINT fk_payment_disputes_4 FOREIGN KEY (tenant_id, store_id, event_id, payment_id) REFERENCES nightclub.payments (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.payment_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.payment_disputes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.payment_disputes FROM PUBLIC;
ALTER TABLE nightclub.coupon_redemptions ADD CONSTRAINT fk_coupon_redemptions_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.coupon_redemptions ADD CONSTRAINT fk_coupon_redemptions_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.coupon_redemptions ADD CONSTRAINT fk_coupon_redemptions_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.coupon_redemptions ADD CONSTRAINT fk_coupon_redemptions_4 FOREIGN KEY (tenant_id, store_id, coupon_id) REFERENCES nightclub.coupons (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.coupon_redemptions ADD CONSTRAINT fk_coupon_redemptions_5 FOREIGN KEY (tenant_id, store_id, event_id, visit_id) REFERENCES nightclub.visits (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.coupon_redemptions ADD CONSTRAINT fk_coupon_redemptions_6 FOREIGN KEY (tenant_id, store_id, event_id, sales_line_id) REFERENCES nightclub.sales_lines (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.coupon_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.coupon_redemptions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.coupon_redemptions FROM PUBLIC;
ALTER TABLE nightclub.sales_attributions ADD CONSTRAINT fk_sales_attributions_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sales_attributions ADD CONSTRAINT fk_sales_attributions_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sales_attributions ADD CONSTRAINT fk_sales_attributions_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sales_attributions ADD CONSTRAINT fk_sales_attributions_4 FOREIGN KEY (tenant_id, store_id, event_id, sales_line_id) REFERENCES nightclub.sales_lines (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sales_attributions ADD CONSTRAINT fk_sales_attributions_5 FOREIGN KEY (tenant_id, store_id, referrer_membership_id) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sales_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.sales_attributions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.sales_attributions FROM PUBLIC;
ALTER TABLE nightclub.reward_rules ADD CONSTRAINT fk_reward_rules_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.reward_rules ADD CONSTRAINT fk_reward_rules_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.reward_rules ADD CONSTRAINT fk_reward_rules_3 FOREIGN KEY (tenant_id, store_id, referrer_membership_id) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.reward_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.reward_rules FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.reward_rules FROM PUBLIC;
ALTER TABLE nightclub.settlements ADD CONSTRAINT fk_settlements_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.settlements ADD CONSTRAINT fk_settlements_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.settlements ADD CONSTRAINT fk_settlements_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.settlements ADD CONSTRAINT fk_settlements_4 FOREIGN KEY (tenant_id, store_id, finalized_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.settlements FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.settlements FROM PUBLIC;
ALTER TABLE nightclub.settlement_lines ADD CONSTRAINT fk_settlement_lines_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.settlement_lines ADD CONSTRAINT fk_settlement_lines_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.settlement_lines ADD CONSTRAINT fk_settlement_lines_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.settlement_lines ADD CONSTRAINT fk_settlement_lines_4 FOREIGN KEY (tenant_id, store_id, event_id, settlement_id) REFERENCES nightclub.settlements (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.settlement_lines ADD CONSTRAINT fk_settlement_lines_5 FOREIGN KEY (tenant_id, store_id, referrer_membership_id) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.settlement_lines ADD CONSTRAINT fk_settlement_lines_6 FOREIGN KEY (tenant_id, store_id, reward_rule_id) REFERENCES nightclub.reward_rules (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.settlement_lines ADD CONSTRAINT fk_settlement_lines_7 FOREIGN KEY (tenant_id, store_id, event_id, admission_event_id) REFERENCES nightclub.admission_events (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.settlement_lines ADD CONSTRAINT fk_settlement_lines_8 FOREIGN KEY (tenant_id, store_id, event_id, sales_line_id) REFERENCES nightclub.sales_lines (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.settlement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.settlement_lines FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.settlement_lines FROM PUBLIC;
ALTER TABLE nightclub.reward_adjustments ADD CONSTRAINT fk_reward_adjustments_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.reward_adjustments ADD CONSTRAINT fk_reward_adjustments_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.reward_adjustments ADD CONSTRAINT fk_reward_adjustments_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.reward_adjustments ADD CONSTRAINT fk_reward_adjustments_4 FOREIGN KEY (tenant_id, store_id, event_id, settlement_line_id) REFERENCES nightclub.settlement_lines (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.reward_adjustments ADD CONSTRAINT fk_reward_adjustments_5 FOREIGN KEY (tenant_id, store_id, created_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.reward_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.reward_adjustments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.reward_adjustments FROM PUBLIC;
ALTER TABLE nightclub.reward_disputes ADD CONSTRAINT fk_reward_disputes_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.reward_disputes ADD CONSTRAINT fk_reward_disputes_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.reward_disputes ADD CONSTRAINT fk_reward_disputes_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.reward_disputes ADD CONSTRAINT fk_reward_disputes_4 FOREIGN KEY (tenant_id, store_id, event_id, settlement_line_id) REFERENCES nightclub.settlement_lines (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.reward_disputes ADD CONSTRAINT fk_reward_disputes_5 FOREIGN KEY (tenant_id, store_id, raised_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.reward_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.reward_disputes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.reward_disputes FROM PUBLIC;
ALTER TABLE nightclub.settlement_payments ADD CONSTRAINT fk_settlement_payments_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.settlement_payments ADD CONSTRAINT fk_settlement_payments_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.settlement_payments ADD CONSTRAINT fk_settlement_payments_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.settlement_payments ADD CONSTRAINT fk_settlement_payments_4 FOREIGN KEY (tenant_id, store_id, event_id, settlement_id) REFERENCES nightclub.settlements (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.settlement_payments ADD CONSTRAINT fk_settlement_payments_5 FOREIGN KEY (tenant_id, store_id, referrer_membership_id) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.settlement_payments ADD CONSTRAINT fk_settlement_payments_6 FOREIGN KEY (tenant_id, store_id, recorded_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.settlement_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.settlement_payments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.settlement_payments FROM PUBLIC;
ALTER TABLE nightclub.cash_sessions ADD CONSTRAINT fk_cash_sessions_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.cash_sessions ADD CONSTRAINT fk_cash_sessions_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.cash_sessions ADD CONSTRAINT fk_cash_sessions_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.cash_sessions ADD CONSTRAINT fk_cash_sessions_4 FOREIGN KEY (tenant_id, store_id, event_id, operator_session_id) REFERENCES nightclub.operator_sessions (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.cash_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.cash_sessions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.cash_sessions FROM PUBLIC;
ALTER TABLE nightclub.command_receipts ADD CONSTRAINT fk_command_receipts_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.command_receipts ADD CONSTRAINT fk_command_receipts_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.command_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.command_receipts FROM PUBLIC;
ALTER TABLE nightclub.event_stream_heads ADD CONSTRAINT fk_event_stream_heads_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.event_stream_heads ADD CONSTRAINT fk_event_stream_heads_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.event_stream_heads ADD CONSTRAINT fk_event_stream_heads_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.event_stream_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.event_stream_heads FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.event_stream_heads FROM PUBLIC;
ALTER TABLE nightclub.outbox_events ADD CONSTRAINT fk_outbox_events_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.outbox_events ADD CONSTRAINT fk_outbox_events_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.outbox_events ADD CONSTRAINT fk_outbox_events_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.outbox_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.outbox_events FROM PUBLIC;
ALTER TABLE nightclub.sync_acks ADD CONSTRAINT fk_sync_acks_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sync_acks ADD CONSTRAINT fk_sync_acks_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sync_acks ADD CONSTRAINT fk_sync_acks_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sync_acks ADD CONSTRAINT fk_sync_acks_4 FOREIGN KEY (tenant_id, store_id, device_id) REFERENCES nightclub.devices (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sync_acks ADD CONSTRAINT fk_sync_acks_5 FOREIGN KEY (tenant_id, store_id, event_id, operator_session_id) REFERENCES nightclub.operator_sessions (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.sync_acks ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.sync_acks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.sync_acks FROM PUBLIC;
ALTER TABLE nightclub.notification_templates ADD CONSTRAINT fk_notification_templates_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.notification_templates ADD CONSTRAINT fk_notification_templates_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.notification_templates FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.notification_templates FROM PUBLIC;
ALTER TABLE nightclub.notification_jobs ADD CONSTRAINT fk_notification_jobs_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.notification_jobs ADD CONSTRAINT fk_notification_jobs_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.notification_jobs ADD CONSTRAINT fk_notification_jobs_3 FOREIGN KEY (tenant_id, store_id, event_id) REFERENCES nightclub.events (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.notification_jobs ADD CONSTRAINT fk_notification_jobs_4 FOREIGN KEY (tenant_id, store_id, event_id, outbox_event_id) REFERENCES nightclub.outbox_events (tenant_id, store_id, event_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.notification_jobs ADD CONSTRAINT fk_notification_jobs_5 FOREIGN KEY (tenant_id, store_id, recipient_membership_id) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.notification_jobs ADD CONSTRAINT fk_notification_jobs_6 FOREIGN KEY (tenant_id, store_id, recipient_customer_id) REFERENCES nightclub.customers (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.notification_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.notification_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.notification_jobs FROM PUBLIC;
ALTER TABLE nightclub.integration_events ADD CONSTRAINT fk_integration_events_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.integration_events ADD CONSTRAINT fk_integration_events_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.integration_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.integration_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.integration_events FROM PUBLIC;
ALTER TABLE nightclub.audit_logs ADD CONSTRAINT fk_audit_logs_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.audit_logs ADD CONSTRAINT fk_audit_logs_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.audit_logs ADD CONSTRAINT fk_audit_logs_3 FOREIGN KEY (tenant_id, store_id, actor_membership_id) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.audit_logs ADD CONSTRAINT fk_audit_logs_4 FOREIGN KEY (tenant_id, store_id, device_id) REFERENCES nightclub.devices (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.audit_logs ADD CONSTRAINT fk_audit_logs_5 FOREIGN KEY (tenant_id, store_id, operator_session_id) REFERENCES nightclub.operator_sessions (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.audit_logs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.audit_logs FROM PUBLIC;
ALTER TABLE nightclub.export_jobs ADD CONSTRAINT fk_export_jobs_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.export_jobs ADD CONSTRAINT fk_export_jobs_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.export_jobs ADD CONSTRAINT fk_export_jobs_3 FOREIGN KEY (tenant_id, store_id, requested_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.export_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.export_jobs FROM PUBLIC;
ALTER TABLE nightclub.import_jobs ADD CONSTRAINT fk_import_jobs_1 FOREIGN KEY (tenant_id) REFERENCES nightclub.tenants (id) ON DELETE RESTRICT;
ALTER TABLE nightclub.import_jobs ADD CONSTRAINT fk_import_jobs_2 FOREIGN KEY (tenant_id, store_id) REFERENCES nightclub.stores (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.import_jobs ADD CONSTRAINT fk_import_jobs_3 FOREIGN KEY (tenant_id, store_id, requested_by) REFERENCES nightclub.memberships (tenant_id, store_id, id) ON DELETE RESTRICT;
ALTER TABLE nightclub.import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nightclub.import_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nightclub.import_jobs FROM PUBLIC;
REVOKE ALL ON SCHEMA nightclub FROM PUBLIC;
-- No permissive policy or broad GRANT is shipped. Backend-role authorization is a required implementation gate.
COMMIT;
