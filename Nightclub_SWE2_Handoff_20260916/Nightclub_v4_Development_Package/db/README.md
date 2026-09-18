# DB参照モデルの利用方法

**状態：設計用参照DDL。アプリ実装・本番migrationではありません。**

model.jsonがカラム・型・null・FKの正本。data_dictionary.csv/mdはその展開。reference_schema.sqlは同じ定義から生成。R1のデータモデルを詳細化し、R2〜R4の契約・POS・3D等は本体の後続Mustとバックログに維持する。

## 安全な評価手順

1. 空の隔離開発DBを用意し、DBバージョンとbtree_gist拡張利用権限を確認。
2. reference_schema.sqlをレビューして実行。既存のnightclub schemaには上書きしない設計。
3. 参照FKとunique・排他制約の意図をdata_dictionaryで確認。
4. 本番用の権限ロール・RLS・コマンド・監査追記・更新時刻処理を実装。
5. 異なるtenant/store/event、同名顧客、入口同時承認、人数・返金の競合試験を実行。

SQLはPUBLICを拒否し、RLSを有効化・強制するが、許可ポリシーは同梱しない。これを回避するために全テーブルへUSING(true)やservice資格情報をブラウザへ配ることは禁止。特権DB接続でアプリを動かしてRLS試験を省略しない。

## DDLで扱うこと／別実装が必要なこと

DDL：PK、FK、tenant/store/eventの複合参照、同一来店・端末・通貨の追加参照、一申請一決定、同一端末一担当、物理テーブル時間の重複防止、非負数等。

コマンド：入口通常承認の認可、自己申請禁止、顧客本人照合、公開版不変、枠合計、部分入場、支払充当、返金合計、全配分100%、カウンタと台帳の一致、audit/outbox、immutable行の運用権限制御。詳細はdocs/transactions.md。

updated_at、versionは自動更新triggerを同梱していない。書込コマンドで期待版を条件に更新する。immutableのテーブルについて通常ロールにUPDATE/DELETEを与えず、訂正を別行で記録する。

## 物理上の留意点

UUIDは顧客名と独立。日本語の名前・読みは原文と検索キーを分離する。名前の一意制約は設けない。FKは同じtenant/storeを保証し、イベント対象同士はeventも含める。

参照DDLの行内CHECKでは複数行の金額・枠・配分合計を保証できない。[T16] APIで直接行を足す実装でなく、トランザクション境界ごとに処理する。全文／部分検索のインデックス、データ量別の性能は実機DBで検証する。prefix索引のみで全てのあいまい検索性能を保証しない。

## 検証状態

この提出時の実行結果はvalidation/report.md。ファイル構造・参照検査と、PostgreSQL実機でのDDL実行・RLS・並列試験を区別する。実行されていない試験をPASSとみなさない。
