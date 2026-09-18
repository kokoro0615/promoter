# Nightclub v4｜要件定義・開発設計パッケージ

**2026-09-15 / Version 4.0 / 開発ベースライン提出版**

## Summary

採用済み：常連はお客様、名前検索中心、料金/人数/期限を管理画面設定、指定承認者に加えて入口も通常から承認、入口は店舗共用タブレット・スマホ。紹介者/DJ/スタッフは個人PWA。入口端末でも操作した個人を識別する。

採用方針＝FACT/High。API・DB・PIN方式・ロック時間等の具体設計＝INFERENCE/Medium。実装、実機、性能、決済、本番運用、競合優位性は未検証。

## 最初に開くファイル

|目的|ファイル|
|---|---|
|正式な業務要求|[要件定義書v4](docs/requirements_v4.md)|
|v3からの変更|[CHANGELOG](CHANGELOG.md)|
|図の閲覧|[ER・フローのローカルビューア](diagrams/index.html)|
|Mermaid全ER|[er_full_r1.mmd](diagrams/er_full_r1.mmd)|
|API|[OpenAPI 3.1.1](api/openapi.yaml)、[範囲と補完ゲート](api/coverage.md)|
|データ構造|[model.json](db/model.json)、[データ辞書](db/data_dictionary.md)、[参照DDL](db/reference_schema.sql)|
|権限と未決定事項|[権限CSV](planning/permissions.csv)、[決定台帳](planning/decision_register.csv)|
|テスト|[受入試験104件](tests/acceptance_cases.csv)、[重点シナリオ](tests/critical_flows.feature)|
|開発順と見積|[バックログ28epic](planning/backlog.csv)、[実行計画](planning/implementation_plan.md)|
|調査根拠|[公式資料と設計判断](research/sources.md)|
|実施した検査|[検証報告](validation/report.md)|

PDF・Wordの要件定義本体はパッケージ直下に収録する：[PDF](Nightclub_Requirements_v4_20260915.pdf)／[Word](Nightclub_Requirements_v4_20260915.docx)。詳細な開発仕様はMarkdown/CSV/JSON/YAMLを正本とし、本体の要約図だけで実装しない。

## 開発担当向けの読む順序

1. 要件本体・CHANGELOG・決定台帳で、採用済みと設計提案を分ける。
2. architecture / shared_device_auth / settings_and_rulesで境界を確認する。
3. ERとmodel.json / data_dictionary / OpenAPIを突合する。
4. transactions / realtime / finance_and_vip / security_and_operationsを実装単位にする。
5. 追跡表・backlog・受入試験を対象スプリントのDefinition of Readyへ接続する。

## 正本と相互関係

最新のユーザー採用決定 → 要件本体の明示変更 → 技術仕様と台帳 → 143機能のRelease → 旧v3原本。DBの単一情報源はdb/model.json。ERは主要カラム、辞書は全カラム、SQLは参照DDL。APIは主要業務の契約案であり全補助CRUD・外部provider確定を意味しない。R2〜R4も削除していない。

仕様不一致を発見した場合、担当者がどちらかを勝手に実装せず、変更ID・影響・試験を登録して調整する。

## 実施済みと未実施

構造検査：JSON/YAML、Schema例、OpenAPI内部参照、モデルFK/一意キー、143機能ID、試験ID、Mermaid描画。純粋な参照計算テストも実行する。

未実施：APIサーバー実装、独立したOpenAPI仕様バリデーターによる全面検証、PostgreSQLでのDDL実行、業務トランザクション/RLS、実機PWA、並列・負荷・障害、PSP試験取引。参照DDLを本番へ直接適用しない。検証報告が最終的な実施状況の根拠。

## 未確定値の扱い

実金額・人数・期限は本番設定前に店舗が入力する。開発はその値をハードコードしない。PSP・認証/ホスティング・POS接続・端末台数/OS・運用当番・保持期間・予算/開始日は決定台帳に担当とゲートを残す。実行可能な例は全て合成データで、本番の設定値ではない。

## ファイル検証

Python 3.11以上とPyYAML・jsonschemaを用意し、ルートで`python tools/validate_package.py`、`python tests/reference_checks.py`を実行する。Mermaid原本は対応エディタ/CLIで再描画する。実環境で使用する依存バージョンは開発時に固定・記録する。

営業開始は設定入力、対象実装、R1試験、夜間運用/復元の承認を経て判定する。本パッケージの納品は営業開始の許可ではない。
