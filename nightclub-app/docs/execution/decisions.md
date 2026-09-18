# decisions.md — ADR / 変更記録

凡例: [採用済み]=上位指示で確定 / [仮採択]=隔離開発での技術選定(本番審査残) / [要承認]=事業者判断

## ADR-IMPL-01 技術基盤 [仮採択]
- 言語/ランタイム: TypeScript + Node.js 24 (環境実在 v24.19.0)
- API: Fastify 5 (単一モジュール分割アプリ = architecture.md ADR-01 選択A)
- DB: PostgreSQL 16.2 (pgserver同梱バイナリ + contribソースからbtree_gistビルド)。Docker/sudo不可の環境制約による。本番同等の engine + extension 構成であり、パッケージマネージャ差異のみ。
- DB接続: node-postgres(pg)生SQL。ロック順・複合FK・排他制約・再送を明示制御するためORM非採用。
- migration: 自前ランナー(連番SQL+適用記録)。0001=参照DDL適用、0002以降=アプリ追加(ロール/RLSポリシー/トリガー/索引)。
- PWA: Vite + React + vite-plugin-pwa。個人PWA/入口PWAは同一アプリのモード分離。
- Realtime: SSE購読 + changes API(変更API主経路・SSEは通知)。ADR-03の常設gateway相当を同一プロセス内で提供。
- Worker: 同一リポジトリ別プロセス(outbox配信/期限処理/通知/照合)。
- 試験: vitest(単体/API統合/実DB並列) + Playwright(ブラウザE2E、キャッシュ済みchromium)。
- 理由: v4 TypeScript案を採用。環境実在ランタイムと一致、外部クラウド非依存でローカル完結。
- 根拠: architecture.md §1-2 / 未確定: 本番ホスティング・常設WS可否 → Evidence needed

## ADR-IMPL-02 認証 [仮採択+一部要承認]
- 個人認証: OIDC抽象化 + 開発用DevIssuer(隔離開発のみ有効、環境変数で明示) + メール代替経路のI/F。LINE OIDC接続は credentials 未提供のためアダプター契約+契約試験まで。実LINE接続=BLOCKED(D-05相当の外部接続ゲート)。
- 入口: 端末ペアリング(管理者の個人セッションで発行した1回限りコード) + device cookie + 個人PIN(Argon2id) + operator cookie + X-Operator-Context 照合。
- 秘密値: .env.exampleに名前のみ。値はコミットしない。

## ADR-IMPL-03 RLS・DBロール [仮採択]
- ロール: app_migrator(所有者相当・適用のみ) / app_runtime(通常バックエンド) / app_readonly(帳票用)。
- 方針: 全表 RLS 有効+FORCE(原本と同じ)。app_runtime は tenant/store GUC(current_setting)一致行のみ。immutable系(audit_logs, command_receipts, outbox_events, admission_events, approval_decisions, entry台帳)は UPDATE/DELETE 権限自体を付与しない。
- 否定系試験を通常ロール接続で実行。特権接続での代替はしない。

## ADR-IMPL-04 同期 [仮採択]
- event_stream_heads行ロック + last_seq++ + outbox同一TX (v4参照方式を採用)。snapshotはREPEATABLE READでcursor+全データ同一スナップショット、snapshot_token=UUID・保持期間付き。
- ACKは snapshot_token+cursor+対象端末を検証し、未送信/将来カーソルは拒否。

## ADR-IMPL-05 契約の現行版管理 [採用済みの運用]
- spec/current/openapi.yaml = 実装版の契約。原本との差分は CHG-IMPL-xxx で本ファイルへ記録。
- config schema は原本コピーを spec/current に保持し変更時は差分記録。

## 変更記録 (原本からの実装差分)
| 変更ID | 対象 | 理由 | 影響・試験 |
|---|---|---|---|
| CHG-IMPL-001 | `x-operator-context` ヘッダー値 = operator_session_id | 端末 cookie と分離し、交代時に stale tab を 409 OPERATOR_CHANGED で確実に失効させるため。`requireOperator` が cookie session と照合する | tests/api operator 交代試験で検証済み |
| CHG-IMPL-002 | `/auth/dev/login` (開発用 issuer) 追加 | LINE OIDC 実接続は資格情報待ち(B-02)。契約: subject+display_name → opaque session cookie。`DEV_AUTH=1` かつ非 production でのみ有効 | e2e/api 全試験で使用 |
| CHG-IMPL-003 | `withReceipt` は業務拒否も `command_receipts` に REJECTED として保存し HTTP 200 ではなく `res.httpStatus` を返却する | 契約「同じキーは同じ結果を再生する」を失敗応答にも適用するため。呼び出し側が `reply.code(res.httpStatus)` を適用する規約 | api: idempotency replay / already-decided / over-remainder が 409/422 で検証済み |
| CHG-IMPL-004 | `GET /device/operators` に `device_id`/`store_id`/`current_operator`/`events` を追加 | 共用端末の kiosk PWA が store スコープのURLを組み立てるために必要 | e2e smoke / device-only 拒否試験 |
| CHG-IMPL-005 | `visitSummary` に `pass_id`/`pass_presence` を追加 | 入口画面が exit/re-entry に必要な group pass を visit 単位で解決するため | api entry 後の pass 遷移で検証 |
| CHG-IMPL-006 | worker は同一リポジトリ別プロセス (`src/worker`) で outbox claim→publish, IN_APP通知fan-out, entry_until失効のhold解放sweep | 参照DDLの outbox/notification_jobs/admission_segments をそのまま利用 | outbox_claim/mark_published を app_runtime で実DB検証済み |

## 要承認・BLOCKED(詳細は blockers.md)
- D-05 PSP選定・実決済接続
- LINE OIDC 実接続(client_id等の秘密値)
- D-09 夜間運用/復旧体制・本番公開判定
- D-10 R2契約・課金条件
- D-11 開発契約/予算承認

## ADR-IMPL-06 R2/R3 プラットフォーム基盤 [採用]
- `platform_command_receipts` / `platform_audit_logs` を新設。`command_receipts`/`audit_logs` は (tenant_id, store_id) NOT NULL + RLS tenant一致のため、テナント横断の platform 操作は別表で同一セマンティクス（冪等レシート・REJECTED保存・監査）を実現。ポリシーは `ctx_scope()='system' AND platform_is_operator()`。
- platform ルートは `requirePlatform`（個人セッション + platform_operators 行を definer 関数で検証）の後、userId を GUC に載せた `sys()` ヘルパーで実行。
- `export_jobs` の RLS に `OR ctx_scope()='system'` を追加 — worker が全テナントの QUEUED ジョブをスキャンするため（UPDATE自体は per-job で tenant/store GUC を設定）。
- チケット token は平文をDBに保存せず sha256 hash のみ。発行時一度だけ返却。

## 変更記録（続き）
| 変更ID | 対象 | 理由 | 影響・試験 |
|---|---|---|---|
| CHG-IMPL-007 | 0003 マイグレーション新設: platform_operators/plans/tenant_subscriptions/billing_invoices/tenant_deletion_requests/tenant_onboarding + ticket_products/orders/instances + products/stock_movements/bottle_keeps + platform_command_receipts/platform_audit_logs | R2/R3 のDB基盤。参照DDLに無い表は 0003 で追加 | api r2r3 18件で検証 |
| CHG-IMPL-008 | `payments.purpose` に TICKET/PRODUCT、`admission_segments.authorization_method` に TICKET を追加 | 券売・POS販売・チケット入場を既存会計/入場構造に乗せるため | redeem→TICKET セグメント検証済み |
| CHG-IMPL-009 | worker `runExports` + `runOnce()` export（WORKER_AUTOSTART=0 でテストから呼び出し可能） | エクスポート実行の実DB検証をテスト内で行うため | export QUEUED→READY→download 200 検証済み |

## ADR-IMPL-07 セキュリティ基盤 [採用]
- 全ルートに runtime schema (params/querystring/body, `additionalProperties:false` 許可リスト化) を適用。Fastify+ajv で strip+検証。
- CSRF: cookie セッションの mutation は `Origin`/`Referer` 検査（same-origin 必須、 Bearer/token 系は除外）。
- レート制限: 認証・公開・高コスト経路に in-memory bucket。公開 booking submission は IP+slug 単位。
- セキュリティヘッダ: onSend で nosniff/frame-deny/referrer 制御等を付与。

## ADR-IMPL-08 認証代替・MFA・PSP抽象化 [採用]
- email-link: `email_login_tokens`(hash保管・単発・期限付き・attempts上限)。redeem で session 発行 + `email` issuer identity 自動bind。メール配送自体は外部接続ゲート(B-11) — 開発では token を応答/ログで受け取る。
- TOTP MFA: `mfa_credentials`(kind=totp) + `mfa_recovery_codes`(hash)。begin→activate→`auth_sessions.step_up_at` で step-up。金銭系コマンド（refund/settlement-payments/精算確定）は enroll 済み個人セッションに fresh step-up を要求。端末オペレータセッションは対象外。
- PSP: `lib/psp.ts` アダプタ層。`dev` プロバイダ実装 + `stripe` seam(未接続・B-01)。webhook は provider_reference で payment を引き、tenant/store GUC 配下で冪等確定。店舗資金は各店舗契約で直接受領 — プラットフォームは資金を受領・移転・精算しない。

## ADR-IMPL-09 公開予約・役割別UI [採用]
- `booking_pages`(slug, settings jsonb) + SECURITY DEFINER `booking_page_lookup` で公開参照は安全列のみ。公開 submission は `APPROVAL_PENDING` の booking として作成し contact を `bookings.contact` に保持。公開 checkout は実装しない（資金境界）。
- 公開ページ close で公開 lookup から除外。スタッフ booking 一覧は contact を返す。
- フロント: `src/web/views/` 役割別分割 (login/promoter/kiosk/admin/adminevt/platform/publicbook) + `ui.tsx` 共有部品。API エラーは problem+json `{code,detail}` で統一。

## ADR-IMPL-10 契約parityの残差分 [採用]
- `GET /stores/{storeId}/exports/{exportId}` は `GET /exports`(一覧=status) + `GET /exports/{exportId}/download` で代替。
- `POST /public/{publicToken}/bookings` は `POST /public/booking-pages/{slug}/submissions` として実装。
- `POST /public/bookings/{publicToken}/checkout` は資金境界のため非実装（公開予約は APPROVAL_PENDING 止まり、支払は店舗直接）。
- 生成物: `tools/api_parity.mjs` → `docs/execution/api_parity.txt`（spec 75/78 実装、impl-only 107）。

## 変更記録（続き2）
| 変更ID | 対象 | 理由 | 影響・試験 |
|---|---|---|---|
| CHG-IMPL-010 | `payments.order_id`/`sales_orders.visit_id`/`integration_events.tenant_id,store_id` NULL許容、`bookings.contact`/`stores.settings`/`events.is_private`/`notification_deliveries.payload` 追加 (0004) | checkout/webhook 死にコードの解消と v5 機能基盤 | vip 8件・回帰全パス |
| CHG-IMPL-011 | webhook は provider_reference で payment を引いてから tenant/store GUC で処理 (system SELECT ポリシー追加) | GUC未設定の裸 system では payments 不可視で全件失敗していた | devpsp webhook 200・booking CONFIRMED 検証 |
| CHG-IMPL-012 | `auth_resolve_session` に `step_up_at` 露出、`email_link_redeem` に email 返却列 (0006) | step-up 判定と email identity 自動bind に必要 | authalt 11件 |
| CHG-IMPL-013 | `nc_stores` WITH CHECK に system scope 許可、非台帳 join/config 表へ DELETE 付与 (0005) | platform 運用者のテナント横断店舗作成と管理操作 | v5endpoints 35件 |
| CHG-IMPL-014 | `booking_pages` + `booking_page_lookup()` SECURITY DEFINER (0007) | 公開参照を安全列に限定するため | publicbook 3件 |
| CHG-IMPL-015 | `sales_attributions.basis_points` 未一致 rule 時 0→10000 | CHECK(1..10000) 違反で referred 入場売上が 500 になる潜在バグ。主紹介者100% | parity/attribution 試験 |
| CHG-IMPL-016 | 権限キー追加: `coupon.manage`,`notification.manage`,`import.manage`,`attribution.manage` (seed ADMIN) | parity 新規コマンドの権限分離 | parity 7件 |
| CHG-IMPL-017 | audit-logs に `actor_display`、customers detail に `tags`、bookings 一覧に `contact` を追加 | 役割別UIが必要とする読み取り面 | 強化済み api 試験で検証 |
