# データ辞書 v4

設計案／Confidence：Medium。R1参照モデル。カラム構造はmodel.json、複合FK・ユニーク・排他制約はreference_schema.sqlを併読。

## tenants — 運営会社単位。外販契約詳細はR2。
領域：01_identity／境界：global／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|name|text|不可|-|name|
|status|text|不可|-|status|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[]
行内制約：

## app_users — 個人主体。ゲスト顧客とは別。
領域：01_identity／境界：global／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|display_name|text|不可|-|display_name|
|status|text|不可|-|status|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[]
行内制約：

## external_identities — LINE/OIDC等の本人認証主体。
領域：01_identity／境界：global／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|user_id|uuid|不可|app_users|user_id|
|issuer|text|不可|-|issuer|
|client_id|text|不可|-|client_id|
|subject|text|不可|-|subject|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['issuer', 'client_id', 'subject']]
行内制約：

## auth_sessions — 個人スマホ用サーバーセッション。外部トークンをブラウザへ渡さない。
領域：01_identity／境界：global／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|user_id|uuid|不可|app_users|user_id|
|token_hash|text|不可|-|ランダムセッションのハッシュ|
|expires_at|timestamptz|不可|-|expires_at|
|revoked_at|timestamptz|可|-|revoked_at|
|step_up_at|timestamptz|可|-|step_up_at|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['token_hash']]
行内制約：

## stores — 店舗。顧客データを他店と自動共有しない。
領域：01_identity／境界：tenant／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|name|text|不可|-|name|
|timezone|text|不可|-|timezone|
|currency|char(3)|不可|-|currency|
|status|text|不可|-|status|
|version|integer|不可|-|version|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'id']]
行内制約：

## memberships — 個人の店舗所属。役職と許可は分離。
領域：01_identity／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|user_id|uuid|不可|app_users|user_id|
|display_name|text|不可|-|display_name|
|status|text|不可|-|status|
|valid_from|timestamptz|不可|-|valid_from|
|valid_to|timestamptz|可|-|valid_to|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'user_id']]
行内制約：valid_to IS NULL OR valid_to > valid_from

## roles — 店舗別ロール定義。
領域：01_identity／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|role_key|text|不可|-|role_key|
|name|text|不可|-|name|
|version|integer|不可|-|version|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'role_key']]
行内制約：

## role_permissions — ロールに付与する許可キー。
領域：01_identity／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|role_id|uuid|不可|roles|role_id|
|permission_key|text|不可|-|permission_key|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'role_id', 'permission_key']]
行内制約：

## membership_roles — 店舗所属とロールの対応。
領域：01_identity／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|membership_id|uuid|不可|memberships|membership_id|
|role_id|uuid|不可|roles|role_id|
|granted_by|uuid|不可|memberships|granted_by|
|expires_at|timestamptz|可|-|expires_at|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'membership_id', 'role_id']]
行内制約：

## invitation_tokens — 加入招待。トークンを平文保存しない。
領域：01_identity／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|token_hash|text|不可|-|token_hash|
|invite_target|text|不可|-|招待先。必要な場合に限定|
|role_id|uuid|不可|roles|role_id|
|issued_by|uuid|不可|memberships|issued_by|
|expires_at|timestamptz|不可|-|expires_at|
|used_at|timestamptz|可|-|used_at|
|used_by|uuid|可|app_users|used_by|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['token_hash']]
行内制約：

## events — 営業単位。深夜跨ぎを一つの営業として扱う。
領域：02_policy_customer／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|name|text|不可|-|name|
|opens_at|timestamptz|不可|-|opens_at|
|closes_at|timestamptz|不可|-|closes_at|
|status|text|不可|-|status|
|version|integer|不可|-|version|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id']]
行内制約：closes_at > opens_at

## event_assignments — 当日権限。入口承認は指定承認者枠とは別。
領域：01_identity／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|membership_id|uuid|不可|memberships|membership_id|
|assignment_kind|text|不可|-|assignment_kind|
|starts_at|timestamptz|不可|-|starts_at|
|ends_at|timestamptz|不可|-|ends_at|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'membership_id', 'assignment_kind']]
行内制約：ends_at > starts_at

## devices — 店舗登録済み入口端末。個人とは別主体。
領域：03_shared_device／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|label|text|不可|-|label|
|status|text|不可|-|status|
|enrolled_by|uuid|不可|memberships|enrolled_by|
|operator_epoch|bigint|不可|-|operator_epoch|
|revoked_at|timestamptz|可|-|revoked_at|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id']]
行内制約：

## device_enrollments — 短期・一回限り端末ペアリング。
領域：03_shared_device／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|device_id|uuid|不可|devices|device_id|
|code_hash|text|不可|-|code_hash|
|issued_by|uuid|不可|memberships|issued_by|
|expires_at|timestamptz|不可|-|expires_at|
|consumed_at|timestamptz|可|-|consumed_at|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['code_hash']]
行内制約：

## device_sessions — 端末cookieに対応。単体で顧客を閲覧できない。
領域：03_shared_device／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|device_id|uuid|不可|devices|device_id|
|token_hash|text|不可|-|token_hash|
|expires_at|timestamptz|不可|-|expires_at|
|revoked_at|timestamptz|可|-|revoked_at|
|last_seen_at|timestamptz|可|-|last_seen_at|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['token_hash'], ['tenant_id', 'store_id', 'device_id', 'id']]
行内制約：

## operator_credentials — 店舗所属ごとの個人PINハッシュと制限。
領域：03_shared_device／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|membership_id|uuid|不可|memberships|membership_id|
|pin_hash|text|不可|-|Argon2id等。salt含む。pepperはDB外|
|failed_attempts|integer|不可|-|failed_attempts|
|locked_until|timestamptz|可|-|locked_until|
|credential_version|integer|不可|-|credential_version|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'membership_id']]
行内制約：

## operator_sessions — 入口の有効担当者。旧画面はsession/epoch不一致で拒否。
領域：03_shared_device／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|device_id|uuid|不可|devices|device_id|
|device_session_id|uuid|不可|device_sessions|device_session_id|
|membership_id|uuid|不可|memberships|membership_id|
|operator_epoch|bigint|不可|-|operator_epoch|
|token_hash|text|不可|-|token_hash|
|expires_at|timestamptz|不可|-|expires_at|
|locked_at|timestamptz|可|-|locked_at|
|ended_at|timestamptz|可|-|ended_at|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['token_hash']]
行内制約：

## customers — 常連を含む顧客台帳。氏名はuniqueではない。
領域：02_policy_customer／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|display_name|text|不可|-|display_name|
|name_key|text|不可|-|検索用正規化。本人IDではない|
|kana_key|text|可|-|任意読みの正規化|
|regular_status|text|不可|-|regular_status|
|masked_hint|text|可|-|照合用の最小ヒント。詳細PIIは返さない|
|contact_ciphertext|text|可|-|必要時だけ暗号化した連絡先|
|version|integer|不可|-|version|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id']]
行内制約：

## customer_aliases — 通称・別名の原文と検索キー。
領域：02_policy_customer／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|customer_id|uuid|不可|customers|customer_id|
|alias|text|不可|-|alias|
|alias_key|text|不可|-|alias_key|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'customer_id', 'alias_key']]
行内制約：

## operating_templates — 曜日・営業のテンプレート下書き。設定は型付きJSON。
領域：02_policy_customer／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|name|text|不可|-|name|
|settings|jsonb|不可|-|policy.schema.jsonに従う|
|version|integer|不可|-|version|
|created_by|uuid|不可|memberships|created_by|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id']]
行内制約：

## policy_versions — 公開設定のスナップショット。公開後は内容不変。
領域：02_policy_customer／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|version|integer|不可|-|version|
|status|text|不可|-|status|
|settings|jsonb|不可|-|settings|
|effective_from|timestamptz|不可|-|effective_from|
|effective_to|timestamptz|不可|-|effective_to|
|apply_mode|text|不可|-|apply_mode|
|published_by|uuid|可|memberships|published_by|
|published_at|timestamptz|可|-|published_at|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'version']]
行内制約：effective_to > effective_from

## price_rules — 設定版に属する料金と入場可能時間。
領域：02_policy_customer／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|policy_version_id|uuid|不可|policy_versions|policy_version_id|
|rule_key|text|不可|-|rule_key|
|price_kind|text|不可|-|price_kind|
|amount_minor|bigint|不可|-|amount_minor|
|currency|char(3)|不可|-|currency|
|entry_from|timestamptz|不可|-|entry_from|
|entry_to|timestamptz|不可|-|entry_to|
|payment_required|boolean|不可|-|payment_required|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'policy_version_id', 'rule_key']]
行内制約：price_kind <> 'FREE' OR amount_minor = 0; entry_to > entry_from

## permits — 常連客本人または実登録者への事前許可の版。
領域：02_policy_customer／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|permit_key|uuid|不可|-|版をまたぐ論理許可ID|
|version|integer|不可|-|version|
|subject_kind|text|不可|-|subject_kind|
|customer_id|uuid|可|customers|customer_id|
|actor_membership_id|uuid|可|memberships|actor_membership_id|
|granted_by|uuid|不可|memberships|granted_by|
|conditions|jsonb|不可|-|permit.schema.json|
|valid_from|timestamptz|不可|-|valid_from|
|valid_to|timestamptz|不可|-|valid_to|
|status|text|不可|-|status|
|supersedes_id|uuid|可|permits|supersedes_id|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'permit_key', 'version']]
行内制約：valid_to > valid_from; (subject_kind = 'CUSTOMER' AND customer_id IS NOT NULL AND actor_membership_id IS NULL) OR (subject_kind = 'ACTOR' AND actor_membership_id IS NOT NULL AND customer_id IS NULL)

## referrer_profiles — DJ／プロモーター／スタッフの集客プロフィール。
領域：01_identity／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|membership_id|uuid|不可|memberships|membership_id|
|stage_name|text|不可|-|stage_name|
|categories|text[]|不可|-|複数区分可|
|contract_reference|text|可|-|contract_reference|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'membership_id']]
行内制約：

## invitation_links — 公開招待。帰属は運ぶが内部許可は運ばない。
領域：04_admission／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|referrer_membership_id|uuid|不可|memberships|referrer_membership_id|
|token_hash|text|不可|-|token_hash|
|expires_at|timestamptz|不可|-|expires_at|
|status|text|不可|-|status|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['token_hash']]
行内制約：

## coupons — 割引クーポンの版・使用枠。フリー権限とは別。
領域：02_policy_customer／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|code_hash|text|不可|-|code_hash|
|version|integer|不可|-|version|
|owner_membership_id|uuid|可|memberships|owner_membership_id|
|conditions|jsonb|不可|-|conditions|
|valid_from|timestamptz|不可|-|valid_from|
|valid_to|timestamptz|不可|-|valid_to|
|status|text|不可|-|status|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'code_hash', 'version']]
行内制約：valid_to > valid_from

## visits — 来店予定。紹介者・入力者を分離。
領域：04_admission／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|customer_id|uuid|可|customers|customer_id|
|referrer_membership_id|uuid|可|memberships|referrer_membership_id|
|created_by|uuid|可|memberships|created_by|
|source|text|不可|-|source|
|reception_name|text|不可|-|reception_name|
|name_key|text|不可|-|name_key|
|planned_count|integer|不可|-|planned_count|
|arrival_status|text|不可|-|arrival_status|
|status|text|不可|-|status|
|version|integer|不可|-|version|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id']]
行内制約：

## visit_members — 必要な場合だけ保持する同伴者・本人。
領域：04_admission／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|visit_id|uuid|不可|visits|visit_id|
|customer_id|uuid|可|customers|customer_id|
|display_name|text|可|-|display_name|
|member_kind|text|不可|-|member_kind|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id']]
行内制約：

## customer_checks — 来店時の本人照合の証跡。氏名選択とは別。
領域：04_admission／境界：event／追記中心：True
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|visit_id|uuid|不可|visits|visit_id|
|customer_id|uuid|不可|customers|customer_id|
|checked_by|uuid|不可|memberships|checked_by|
|operator_session_id|uuid|可|operator_sessions|operator_session_id|
|method|text|不可|-|method|
|note|text|可|-|必要最小限の説明。ID画像は保存しない|
|valid_until|timestamptz|不可|-|valid_until|
|revoked_at|timestamptz|可|-|revoked_at|
|created_at|timestamptz|不可|-|サーバー作成時刻|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'visit_id', 'id']]
行内制約：

## admission_segments — 来店内の条件別人数。追加・混在を分離。
領域：04_admission／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|visit_id|uuid|不可|visits|visit_id|
|price_rule_id|uuid|不可|price_rules|price_rule_id|
|permit_id|uuid|可|permits|permit_id|
|required_customer_id|uuid|可|customers|required_customer_id|
|requested_count|integer|不可|-|requested_count|
|authorized_count|integer|不可|-|authorized_count|
|first_entered_count|integer|不可|-|first_entered_count|
|unit_amount_minor|bigint|不可|-|unit_amount_minor|
|currency|char(3)|不可|-|currency|
|status|text|不可|-|status|
|authorization_method|text|可|-|authorization_method|
|snapshot|jsonb|不可|-|設定・条件・許可の判定根拠|
|version|integer|不可|-|version|
|entry_until|timestamptz|不可|-|entry_until|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'visit_id', 'id']]
行内制約：first_entered_count <= authorized_count; authorized_count <= requested_count

## approval_requests — 条件内訳ごとの申請版。確定後の再提出は新しい行。
領域：04_admission／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|segment_id|uuid|不可|admission_segments|segment_id|
|requested_by|uuid|不可|memberships|requested_by|
|request_version|integer|不可|-|request_version|
|segment_version|integer|不可|-|segment_version|
|reason|text|不可|-|reason|
|status|text|不可|-|status|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'segment_id', 'request_version']]
行内制約：

## approval_decisions — 一申請一決定。通常入口承認を独立した経路で記録。
領域：04_admission／境界：event／追記中心：True
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|request_id|uuid|不可|approval_requests|request_id|
|decided_by|uuid|不可|memberships|decided_by|
|operator_session_id|uuid|可|operator_sessions|operator_session_id|
|route|text|不可|-|route|
|decision|text|不可|-|decision|
|reason|text|可|-|reason|
|operation_id|uuid|不可|-|operation_id|
|created_at|timestamptz|不可|-|サーバー作成時刻|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'request_id'], ['tenant_id', 'store_id', 'operation_id']]
行内制約：route <> 'ENTRANCE' OR operator_session_id IS NOT NULL; decision = 'APPROVED' OR NULLIF(btrim(reason),'') IS NOT NULL

## quota_buckets — 営業・紹介者・許可等の枠。設定版を変えて使用量をリセットしない。
領域：04_admission／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|bucket_key|text|不可|-|安定した枠キー|
|bucket_kind|text|不可|-|bucket_kind|
|limit_mode|text|不可|-|limit_mode|
|limit_count|integer|可|-|limit_count|
|held_count|integer|不可|-|held_count|
|consumed_count|integer|不可|-|consumed_count|
|version|integer|不可|-|version|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'bucket_key']]
行内制約：(limit_mode='LIMITED' AND limit_count IS NOT NULL AND held_count+consumed_count <= limit_count) OR (limit_mode='UNLIMITED' AND limit_count IS NULL)

## quota_allocations — 条件内訳と各枠の引当。取消の二重返却を防ぐ。
領域：04_admission／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|bucket_id|uuid|不可|quota_buckets|bucket_id|
|segment_id|uuid|不可|admission_segments|segment_id|
|held_count|integer|不可|-|held_count|
|consumed_count|integer|不可|-|consumed_count|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'bucket_id', 'segment_id']]
行内制約：

## entry_passes — 代表QRまたは個別再入場パス。
領域：04_admission／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|visit_id|uuid|不可|visits|visit_id|
|member_id|uuid|可|visit_members|member_id|
|token_hash|text|不可|-|token_hash|
|pass_kind|text|不可|-|pass_kind|
|presence|text|不可|-|presence|
|expires_at|timestamptz|不可|-|expires_at|
|revoked_at|timestamptz|可|-|revoked_at|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['token_hash'], ['tenant_id', 'store_id', 'event_id', 'visit_id', 'id']]
行内制約：

## admission_events — 追記型入退場台帳。訂正は元行を参照する別記録。
領域：04_admission／境界：event／追記中心：True
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|visit_id|uuid|不可|visits|visit_id|
|segment_id|uuid|不可|admission_segments|segment_id|
|pass_id|uuid|可|entry_passes|pass_id|
|operator_session_id|uuid|不可|operator_sessions|operator_session_id|
|actor_membership_id|uuid|不可|memberships|actor_membership_id|
|customer_check_id|uuid|可|customer_checks|customer_check_id|
|kind|text|不可|-|kind|
|quantity|integer|不可|-|quantity|
|present_delta|integer|不可|-|present_delta|
|first_entry_delta|integer|不可|-|first_entry_delta|
|corrects_id|uuid|可|admission_events|corrects_id|
|operation_id|uuid|不可|-|operation_id|
|reason|text|可|-|reason|
|created_at|timestamptz|不可|-|サーバー作成時刻|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'operation_id', 'segment_id']]
行内制約：kind <> 'FIRST_ENTRY' OR (present_delta=quantity AND first_entry_delta=quantity); kind <> 'EXIT' OR (present_delta=-quantity AND first_entry_delta=0); kind <> 'REENTRY' OR (present_delta=quantity AND first_entry_delta=0 AND pass_id IS NOT NULL AND quantity=1); kind <> 'CORRECTION' OR (corrects_id IS NOT NULL AND reason IS NOT NULL)

## provisional_entries — 通信断時の責任者による暫定記録。通常実績に混ぜない。
領域：04_admission／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|device_id|uuid|不可|devices|device_id|
|actor_membership_id|uuid|不可|memberships|actor_membership_id|
|visit_id|uuid|可|visits|visit_id|
|local_operation_id|uuid|不可|-|local_operation_id|
|device_time|timestamptz|不可|-|device_time|
|quantity|integer|不可|-|quantity|
|reception_name|text|不可|-|reception_name|
|reason|text|不可|-|reason|
|status|text|不可|-|status|
|reconciled_entry_id|uuid|可|admission_events|reconciled_entry_id|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'device_id', 'local_operation_id']]
行内制約：

## floor_maps — 配置の版。tableの物理IDは配置版変更でも維持。
領域：05_vip_payment／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|version|integer|不可|-|version|
|layout|jsonb|不可|-|layout|
|status|text|不可|-|status|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'version']]
行内制約：

## venue_tables — 物理テーブル。イベントを跨ぐ競合も防ぐ。
領域：05_vip_payment／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|table_code|text|不可|-|table_code|
|zone|text|不可|-|zone|
|capacity_min|integer|不可|-|capacity_min|
|capacity_max|integer|不可|-|capacity_max|
|status|text|不可|-|status|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'table_code']]
行内制約：capacity_max>=capacity_min

## bookings — VIP予約。入場許可・決済とは独立。
領域：05_vip_payment／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|visit_id|uuid|不可|visits|visit_id|
|customer_id|uuid|可|customers|customer_id|
|party_count|integer|不可|-|party_count|
|starts_at|timestamptz|不可|-|starts_at|
|ends_at|timestamptz|不可|-|ends_at|
|hold_expires_at|timestamptz|可|-|hold_expires_at|
|status|text|不可|-|status|
|admission_pricing|text|不可|-|admission_pricing|
|minimum_minor|bigint|不可|-|minimum_minor|
|deposit_minor|bigint|不可|-|deposit_minor|
|currency|char(3)|不可|-|currency|
|policy_snapshot|jsonb|不可|-|policy_snapshot|
|version|integer|不可|-|version|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'visit_id', 'id']]
行内制約：ends_at>starts_at

## booking_decisions — 店舗予約ルールが手動承認の場合の判断。フリー承認と別。
領域：05_vip_payment／境界：event／追記中心：True
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|booking_id|uuid|不可|bookings|booking_id|
|booking_version|integer|不可|-|booking_version|
|actor_membership_id|uuid|不可|memberships|actor_membership_id|
|decision|text|不可|-|decision|
|reason|text|可|-|reason|
|created_at|timestamptz|不可|-|サーバー作成時刻|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'booking_id', 'booking_version']]
行内制約：

## table_allocations — 準備時間を含む物理テーブル占有。期限経過は明示的に解放。
領域：05_vip_payment／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|booking_id|uuid|不可|bookings|booking_id|
|table_id|uuid|不可|venue_tables|table_id|
|occupied_during|tstzrange|不可|-|occupied_during|
|status|text|不可|-|status|
|expires_at|timestamptz|可|-|expires_at|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id']]
行内制約：NOT isempty(occupied_during) AND NOT lower_inf(occupied_during) AND NOT upper_inf(occupied_during) AND lower_inc(occupied_during) AND NOT upper_inc(occupied_during)

## sales_orders — 来店・VIP会計。事前預りを売上行にしない。
領域：05_vip_payment／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|kind|text|不可|-|kind|
|visit_id|uuid|不可|visits|visit_id|
|booking_id|uuid|可|bookings|booking_id|
|currency|char(3)|不可|-|currency|
|status|text|不可|-|status|
|external_system|text|可|-|external_system|
|external_order_id|text|可|-|external_order_id|
|version|integer|不可|-|version|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'external_system', 'external_order_id'], ['tenant_id', 'store_id', 'event_id', 'id', 'currency']]
行内制約：

## sales_lines — 確定した利用明細。業務売上と法定会計の認識は別。
領域：05_vip_payment／境界：event／追記中心：True
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|order_id|uuid|不可|sales_orders|order_id|
|segment_id|uuid|可|admission_segments|segment_id|
|category|text|不可|-|category|
|line_kind|text|不可|-|line_kind|
|description|text|不可|-|description|
|quantity|integer|不可|-|quantity|
|gross_minor|bigint|不可|-|gross_minor|
|tax_minor|bigint|不可|-|tax_minor|
|currency|char(3)|不可|-|currency|
|adjusts_line_id|uuid|可|sales_lines|adjusts_line_id|
|source_key|text|不可|-|入場操作や外部明細IDの重複防止キー|
|created_at|timestamptz|不可|-|サーバー作成時刻|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'source_key'], ['tenant_id', 'store_id', 'event_id', 'order_id', 'id', 'currency']]
行内制約：(line_kind='SALE' AND gross_minor>=0 AND tax_minor>=0) OR (line_kind='CREDIT' AND gross_minor<=0 AND tax_minor<=0 AND adjusts_line_id IS NOT NULL); abs(tax_minor)<=abs(gross_minor)

## payments — 入金と預り。決済回数と売上額を分離。
領域：05_vip_payment／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|recorded_by|uuid|可|memberships|recorded_by|
|operator_session_id|uuid|可|operator_sessions|operator_session_id|
|order_id|uuid|不可|sales_orders|order_id|
|method|text|不可|-|method|
|purpose|text|不可|-|purpose|
|amount_minor|bigint|不可|-|amount_minor|
|currency|char(3)|不可|-|currency|
|status|text|不可|-|status|
|provider|text|可|-|provider|
|provider_account|text|可|-|provider_account|
|provider_reference|text|可|-|provider_reference|
|operation_id|uuid|不可|-|operation_id|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'operation_id'], ['provider', 'provider_account', 'provider_reference'], ['tenant_id', 'store_id', 'event_id', 'id', 'currency']]
行内制約：

## payment_allocations — 支払・預りを会計・売上行に充当。返金の解除は符号付き調整。
領域：05_vip_payment／境界：event／追記中心：True
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|sales_line_id|uuid|可|sales_lines|sales_line_id|
|payment_id|uuid|不可|payments|payment_id|
|order_id|uuid|不可|sales_orders|order_id|
|amount_minor|bigint|不可|-|amount_minor|
|currency|char(3)|不可|-|currency|
|reverses_id|uuid|可|payment_allocations|reverses_id|
|operation_id|uuid|不可|-|operation_id|
|created_at|timestamptz|不可|-|サーバー作成時刻|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'operation_id']]
行内制約：amount_minor>0 OR reverses_id IS NOT NULL

## refunds — 返金指示と外部結果。売上取消・割当解除は別取引で関連付け。
領域：05_vip_payment／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|payment_id|uuid|不可|payments|payment_id|
|amount_minor|bigint|不可|-|amount_minor|
|currency|char(3)|不可|-|currency|
|status|text|不可|-|status|
|reason|text|不可|-|reason|
|requested_by|uuid|不可|memberships|requested_by|
|provider_reference|text|可|-|provider_reference|
|operation_id|uuid|不可|-|operation_id|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'operation_id']]
行内制約：

## payment_disputes — チャージバック・調査と報酬調整の根拠。
領域：05_vip_payment／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|payment_id|uuid|不可|payments|payment_id|
|provider_reference|text|不可|-|provider_reference|
|amount_minor|bigint|不可|-|amount_minor|
|status|text|不可|-|status|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'provider_reference']]
行内制約：

## coupon_redemptions — クーポンの確定引当と使用・取消。
領域：05_vip_payment／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|coupon_id|uuid|不可|coupons|coupon_id|
|visit_id|uuid|不可|visits|visit_id|
|sales_line_id|uuid|可|sales_lines|sales_line_id|
|status|text|不可|-|status|
|operation_id|uuid|不可|-|operation_id|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'operation_id']]
行内制約：

## sales_attributions — 売上行の帰属。R1は主紹介者100%。
領域：06_settlement／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|sales_line_id|uuid|不可|sales_lines|sales_line_id|
|referrer_membership_id|uuid|不可|memberships|referrer_membership_id|
|basis_points|integer|不可|-|basis_points|
|version|integer|不可|-|version|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'sales_line_id', 'referrer_membership_id', 'version']]
行内制約：

## reward_rules — 報酬契約版。単価・率・丸め・除外条件。
領域：06_settlement／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|rule_key|uuid|不可|-|rule_key|
|version|integer|不可|-|version|
|referrer_membership_id|uuid|可|memberships|referrer_membership_id|
|conditions|jsonb|不可|-|conditions|
|valid_from|timestamptz|不可|-|valid_from|
|valid_to|timestamptz|不可|-|valid_to|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'rule_key', 'version']]
行内制約：valid_to>valid_from

## settlements — 営業と報酬の締め版。確定後上書きしない。
領域：06_settlement／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|version|integer|不可|-|version|
|status|text|不可|-|status|
|finalized_by|uuid|可|memberships|finalized_by|
|finalized_at|timestamptz|可|-|finalized_at|
|exception_note|text|可|-|exception_note|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'version']]
行内制約：

## settlement_lines — 計算根拠へ遡れる紹介者別明細。
領域：06_settlement／境界：event／追記中心：True
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|settlement_id|uuid|不可|settlements|settlement_id|
|referrer_membership_id|uuid|不可|memberships|referrer_membership_id|
|reward_rule_id|uuid|不可|reward_rules|reward_rule_id|
|admission_event_id|uuid|可|admission_events|admission_event_id|
|sales_line_id|uuid|可|sales_lines|sales_line_id|
|amount_minor|bigint|不可|-|amount_minor|
|currency|char(3)|不可|-|currency|
|calculation|jsonb|不可|-|基準数・単価／率・丸め・規則版|
|source_key|text|不可|-|source_key|
|created_at|timestamptz|不可|-|サーバー作成時刻|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'settlement_id', 'source_key']]
行内制約：num_nonnulls(admission_event_id,sales_line_id)=1

## reward_adjustments — 締め後調整。元明細と理由を保存。
領域：06_settlement／境界：event／追記中心：True
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|settlement_line_id|uuid|不可|settlement_lines|settlement_line_id|
|amount_minor|bigint|不可|-|amount_minor|
|reason|text|不可|-|reason|
|created_by|uuid|不可|memberships|created_by|
|operation_id|uuid|不可|-|operation_id|
|created_at|timestamptz|不可|-|サーバー作成時刻|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'operation_id']]
行内制約：

## reward_disputes — 紹介者の報酬異議。
領域：06_settlement／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|settlement_line_id|uuid|不可|settlement_lines|settlement_line_id|
|raised_by|uuid|不可|memberships|raised_by|
|reason|text|不可|-|reason|
|status|text|不可|-|status|
|resolution|text|可|-|resolution|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id']]
行内制約：

## settlement_payments — 外部で実施した報酬支払記録。銀行送金実行は含まない。
領域：06_settlement／境界：event／追記中心：True
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|settlement_id|uuid|不可|settlements|settlement_id|
|referrer_membership_id|uuid|不可|memberships|referrer_membership_id|
|amount_minor|bigint|不可|-|amount_minor|
|currency|char(3)|不可|-|currency|
|external_reference|text|不可|-|external_reference|
|recorded_by|uuid|不可|memberships|recorded_by|
|paid_at|timestamptz|不可|-|paid_at|
|created_at|timestamptz|不可|-|サーバー作成時刻|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'external_reference']]
行内制約：

## cash_sessions — 入口シフト現金照合。
領域：06_settlement／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|operator_session_id|uuid|不可|operator_sessions|operator_session_id|
|opening_minor|bigint|不可|-|opening_minor|
|counted_minor|bigint|可|-|counted_minor|
|closed_at|timestamptz|可|-|closed_at|
|difference_note|text|可|-|difference_note|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id']]
行内制約：

## command_receipts — 書込冪等キー・正規化リクエストハッシュ・再送結果。
領域：07_sync_audit／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|actor_key|text|不可|-|認証由来の個人／公開セッション／workerのキー|
|operation_key|text|不可|-|operation_key|
|operation_name|text|不可|-|operation_name|
|request_hash|text|不可|-|request_hash|
|status|text|不可|-|status|
|http_status|integer|可|-|http_status|
|response_body|jsonb|可|-|response_body|
|expires_at|timestamptz|不可|-|expires_at|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'actor_key', 'operation_name', 'operation_key']]
行内制約：

## event_stream_heads — 営業ごとのコミット順序用カウンタ。sequenceを使わない。
領域：07_sync_audit／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|last_seq|bigint|不可|-|last_seq|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'event_id']]
行内制約：

## outbox_events — DB更新と同時保存。配送は重複し得る。
領域：07_sync_audit／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|stream_seq|bigint|不可|-|stream_seq|
|event_type|text|不可|-|event_type|
|aggregate_type|text|不可|-|aggregate_type|
|aggregate_id|uuid|不可|-|aggregate_id|
|aggregate_version|integer|不可|-|aggregate_version|
|payload|jsonb|不可|-|内部最小イベント。公開は権限別に射影|
|trace_id|uuid|不可|-|trace_id|
|published_at|timestamptz|可|-|published_at|
|attempts|integer|不可|-|attempts|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'stream_seq']]
行内制約：

## sync_acks — 入口端末ごとの適用済みストリーム位置。既読ではない。
領域：07_sync_audit／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|device_id|uuid|不可|devices|device_id|
|operator_session_id|uuid|不可|operator_sessions|operator_session_id|
|applied_seq|bigint|不可|-|applied_seq|
|snapshot_token_hash|text|不可|-|snapshot_token_hash|
|last_seen_at|timestamptz|不可|-|last_seen_at|
|visibility|text|不可|-|visibility|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'device_id']]
行内制約：

## notification_templates — 通知文言とローカライズ。
領域：07_sync_audit／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|template_key|text|不可|-|template_key|
|locale|text|不可|-|locale|
|version|integer|不可|-|version|
|body|text|不可|-|body|
|status|text|不可|-|status|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'template_key', 'locale', 'version']]
行内制約：

## notification_jobs — 通知・再送。外部連絡先は最小化。
領域：07_sync_audit／境界：event／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|event_id|uuid|不可|events|日付跨ぎを含む営業ID|
|outbox_event_id|uuid|可|outbox_events|outbox_event_id|
|recipient_membership_id|uuid|可|memberships|recipient_membership_id|
|recipient_customer_id|uuid|可|customers|recipient_customer_id|
|channel|text|不可|-|channel|
|dedup_key|text|不可|-|dedup_key|
|status|text|不可|-|status|
|scheduled_at|timestamptz|不可|-|scheduled_at|
|attempts|integer|不可|-|attempts|
|provider_reference|text|可|-|provider_reference|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'event_id', 'id'], ['tenant_id', 'store_id', 'dedup_key']]
行内制約：num_nonnulls(recipient_membership_id,recipient_customer_id)=1

## integration_events — 署名検証済みWebhook・CSV受領。再送と順序逆転を照合。
領域：07_sync_audit／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|provider|text|不可|-|provider|
|provider_account|text|不可|-|provider_account|
|external_event_id|text|不可|-|external_event_id|
|payload_hash|text|不可|-|payload_hash|
|payload|jsonb|不可|-|payload|
|status|text|不可|-|status|
|attempts|integer|不可|-|attempts|
|error_code|text|可|-|error_code|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['provider', 'provider_account', 'external_event_id']]
行内制約：

## audit_logs — 通常利用者が変更しない監査。保持・匿名化は別の管理手順。
領域：07_sync_audit／境界：store／追記中心：True
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|actor_membership_id|uuid|可|memberships|actor_membership_id|
|device_id|uuid|可|devices|device_id|
|operator_session_id|uuid|可|operator_sessions|operator_session_id|
|action|text|不可|-|action|
|target_type|text|不可|-|target_type|
|target_id|uuid|不可|-|target_id|
|before_version|integer|可|-|before_version|
|after_version|integer|可|-|after_version|
|changes|jsonb|不可|-|必要な差分のみ。秘密・PIN・外部トークンを含めない|
|reason|text|可|-|reason|
|trace_id|uuid|不可|-|trace_id|
|created_at|timestamptz|不可|-|サーバー作成時刻|

一意制約：[['tenant_id', 'store_id', 'id']]
行内制約：

## export_jobs — 帳票生成と権限付き短期成果物。
領域：07_sync_audit／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|requested_by|uuid|不可|memberships|requested_by|
|report_kind|text|不可|-|report_kind|
|filters|jsonb|不可|-|filters|
|format|text|不可|-|format|
|status|text|不可|-|status|
|object_key|text|可|-|object_key|
|expires_at|timestamptz|可|-|expires_at|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id']]
行内制約：

## import_jobs — 移行ファイルの試行取込・検証・本反映。
領域：07_sync_audit／境界：store／追記中心：False
|列|型|NULL|参照|意味|
|---|---|---|---|---|
|id|uuid|不可|-|内部識別子。表示名とは独立|
|tenant_id|uuid|不可|tenants|テナント境界|
|store_id|uuid|不可|stores|店舗境界|
|requested_by|uuid|不可|memberships|requested_by|
|source_system|text|不可|-|source_system|
|file_hash|text|不可|-|file_hash|
|status|text|不可|-|status|
|mapping|jsonb|不可|-|mapping|
|validation_errors|jsonb|不可|-|validation_errors|
|operation_id|uuid|不可|-|operation_id|
|version|integer|不可|-|楽観ロック用の更新版|
|created_at|timestamptz|不可|-|サーバー作成時刻|
|updated_at|timestamptz|不可|-|更新時刻。更新処理が明示設定|

一意制約：[['tenant_id', 'store_id', 'id'], ['tenant_id', 'store_id', 'operation_id']]
行内制約：
