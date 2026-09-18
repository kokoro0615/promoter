# source-map.md — 入力ファイル読了記録

作成: 2026-09-16 / Phase 0

PACKAGE_ROOT = `/home/kokoro/projects/clients/promoter/Nightclub_SWE2_Handoff_20260916/Nightclub_v4_Development_Package`
(sha256 MANIFEST 全90ファイル一致を確認。原本は変更しない。実装用改訂契約は `nightclub-app/spec/current/`。)

## 読了したファイルと要点

| ファイル | 版 | 対象ID | 実装上の要点 |
|---|---|---|---|
| README.md | v4.0 2026-09-15 | 全体 | 採用済み方針(常連=客/名前検索/管理設定/入口通常承認/共用端末)。Markdown/CSV/JSON/YAMLが正本 |
| CHANGELOG.md | v4.0 | CH4-01〜06 | v3→v4差分。入口通常承認のOVERRIDE記録禁止 |
| FILE_INDEX.md | - | 全90ファイル | 構成確認 |
| SWE2_MASTER_PROMPT.md | 1.0 | 実行指示 | 全節確認済み |
| AGENTS.md(ハンドオフ) | - | 継続ルール | 業務不変条件の常時参照 |
| PROMPT_VERIFICATION.md | 1.0 | - | 原本との対応・検査記録 |
| docs/requirements_v4.md | v4.0 | 145詳細要件ID | 全節確認。優先順位U4>U3>変更記録>V4>v4改訂V3>付録A |
| docs/developer_handoff.md | - | DoR/DoD | 最初の実装単位5項目 |
| docs/architecture.md | 設計案 | ADR-01〜06 | 単一DB+短い取引、API経由書込、Realtime+変更API、端末+PIN、承認/入場別コマンド、共有DB厳格境界 |
| docs/shared_device_auth.md | 設計案 | V4-KSK群 | 3 cookie分離、X-Operator-Context照合、PIN 6桁以上/5回失敗300秒停止(初期案)、無操作180秒、交代時epoch+1・旧タブ409 |
| docs/settings_and_rules.md | 設計案 | V4-CFG群 | 判定優先順位6段、UNSET/LIMITED 0/UNLIMITED区別、消費=初回入場+未入場確定引当、preview_token/expected_version公開 |
| docs/transactions.md | 設計案 | TX-01〜09 | ロック順規約、Idempotency-Key範囲(tenant/store/actor/operation/key)、先着1決定、排他制約→409変換 |
| docs/realtime.md | 設計案 | V3-SYNC群 | event_stream_headsロック下採番(commit順保証)、REPEATABLE READ snapshot、ACK=配布版適用の証跡、raw outbox非公開 |
| docs/finance_and_vip.md | 設計案 | V3-VIP/PAY/FIN群 | 預り≠利用額、例:預り2万+利用8万=残6万、返金処理中は利用可能残高から予約、配分10000bp |
| docs/security_and_operations.md | 設計案 | V3-SEC/NFR群 | RLS防御の一層、監査対象一覧、CSV無害化、障害Runbook表 |
| docs/ui_spec.md | 設計案 | UI-01〜14 | 44px操作領域、日英UI、承認→同一画面で入場、色+文字併記 |
| db/README.md | - | DB利用方法 | model.json正本、DDL参照、RLS有効+FORCE+PUBLIC拒否の閉状態 |
| db/model.json | 4.0.0 | 67表 | 全表名・カラム・FK・unique確認(機械集計)。実装時に表ごと再読 |
| db/reference_schema.sql | - | 67表 | 実DB(PG16.2)適用済み検証 → evidence/phase0_ddl_apply.log |
| api/coverage.md | - | 契約範囲 | 主要業務のみ契約化。補助API/外部callback/PSP Webhookは機能実装前に補完 |
| api/openapi.yaml | 3.1.1 | 72パス/78操作/93 schema | securitySchemes=PersonalSession/DeviceSession/OperatorSession。全操作 DESIGN_NOT_IMPLEMENTED |
| api/operations.csv | - | 78操作 | 操作→権限→要件ID対応表を確認 |
| api/error_codes.csv | - | 22コード | RFC9457+code/trace_id。409版競合/422業務不成立/429試行制限/503結果不明 |
| api/events_and_notifications.md | - | 通知 | outbox少なくとも1回、受信側重複排除、通知既読≠成立条件 |
| api/sync-event.schema.json / example | - | 最小無効化イベント | spec/currentへコピー済み |
| config/*.schema.json + *.example.json | - | policy/permit/kiosk | JSON Schema 4組。UNSETは公開不可、preview_token、environment=EXAMPLE_ONLY |
| planning/decision_register.csv | - | D-01〜11 | D-05(PSP)・D-09(運用)・D-10(R2)・D-11(契約)がOPEN。D-01〜04は方式確定済み(残=店舗値) |
| planning/backlog.csv | - | EP01〜28 | R1=EP01〜23。依存関係を確認 |
| planning/implementation_plan.md | - | 順序1〜6 | バックログの順序確認 |
| planning/permissions.csv | - | 権限56行 | approval.decide: 入口=当日入口承認担当として通常から可(待機/不在/到着条件なし) |
| planning/requirements_traceability.csv | - | 145件 | 要件ID→operation対応 |
| planning/legacy_143_traceability.csv | - | 143件 | v2継承機能→Release対応 |
| tests/README.md | - | 104件 | 全件NOT_RUN。原本保持、実行用コピーで管理 |
| tests/acceptance_cases.csv | - | 104件 | R1=101件、R2〜R4各1件 |
| tests/critical_flows.feature | - | 重点シナリオ | Gherkin、step未実装 |
| tests/reference_checks.py | - | 13件 | 隔離コピーで実行 PASS |
| tools/validate_package.py | - | 7検査群 | 隔離コピーで実行 PASS(ログは原本を書換えるため隔離実行) |
| validation/report.md | - | 実施済み検査 | 静的検査のみ。API実装・実DB・RLS・並列・実機・PSPは全てNOT_RUN |
| research/sources.md / sources.json | - | T/W番号 | 技術一次資料の参照リスト |
| baseline/requirements_v3_original.md | v3 | 履歴 | SHA-256照合済み。入口制限への回帰根拠にしない |
| diagrams/*.mmd(16) | - | ER/sequence/state | er_full_r1.mmd=67 entity確認。各Epic着手時に対象図を再読 |

## 実数の検証結果
- 143継承機能ID / 145詳細要件ID / 104受入試験ID / 28 Epic — validate_package.py の TRACEABILITY で再集計一致
- 受入試験内訳: R1=101(AT-01〜57 + AT4-01〜44)、R2〜R4=各1(AT-58/59/60)
- 参照DDL: PostgreSQL 16.2実機へ全67表適用成功(btree_gistはcontribソースからビルドして追加)
