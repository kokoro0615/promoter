# 調査根拠と採用判断 v4

確認日：2026-09-15。技術情報は一次資料のみ。公開仕様の確認はFACT／Confidence：High、そこから選んだ自社設計はINFERENCE／Confidence：Medium。製品・契約・性能の採用／検証とは別。

## 技術調査と要件への反映
|ID|一次資料|確認内容：FACT|本案への適用：設計判断|
|---|---|---|---|
|T01|Mermaid ER diagram|ER関係・多重度・属性・PK/FK表記が定義される。|ERを.mmdで提供。NOT NULL・複合参照の強制はDB辞書とDDLで補足。|
|T02|OpenAPI 3.1.1|HTTP APIを機械可読で記述する仕様。|互換性重視で3.1.1を選ぶ設計案。最新版と称さない。|
|T03|PostgreSQL Row Security|RLSの有効化、既定拒否、所有者・BYPASSRLSなどの例外がある。|RLS＋API認可＋限定DBロール。参照DDLの既定拒否だけで本番可とはしない。|
|T04|PostgreSQL Explicit Locking|行ロックと競合・デッドロックの挙動を説明する。|人数・枠・申請を短い取引で検証し、ロック順を統一する。|
|T05|PostgreSQL Transaction Isolation|分離レベルと、sequenceが通常の取引ロールバックと異なることを説明。|単なるBIGSERIAL最大値を安全な同期カーソルとしない。|
|T06|OWASP Session Management|セッション保護・失効・更新・タイムアウトを扱う。|端末と担当者を別セッションにし、背景化と交代でロックする。時間値は自社提案。|
|T07|OWASP Authorization|最小権限・既定拒否・各要求での認可が重要。|画面の役職表示でなく、有効所属・営業役割・対象行を毎回検証。|
|T08|OWASP Password Storage|パスワードの安全なハッシュ保存とpepper分離を説明。|PINにもサーバー側のハッシュ・試行制限を適用。短いPIN単独は外部認証に使わない。|
|T09|LINE Web Login|Web認可コードフロー、state・nonce・PKCEの仕様を掲載。|個人PWAはLINE認証＋独自所属。共用端末に個人LINEのSSOを残さない。|
|T10|WebKit Web Push|iOS/iPadOSのホーム画面Webアプリと通知許可について説明。|PWA通知は補助。名前検索と一覧更新を通知既読に依存させない。|
|T11|web.dev PWA installation|PWAのインストール方法がブラウザ・OSで異なる。|入口端末と個人端末それぞれで追加・起動・復帰を実機試験。|
|T12|Stripe webhooks|署名検証、再配送、重複、イベント順序について説明。|PSPアダプターは真正性、受領ID、再照会で照合。Stripe採用決定を意味しない。|
|T13|Stripe idempotency|冪等キーによる同一要求の再試行を提供する。|内部の業務冪等キーとPSP側キーを関連付け、保持期限の違いを考慮。|
|T14|AWS transactional outbox|DB更新とメッセージ送信の二重書込不整合を扱うパターン。|Outboxを同じDB取引で保存し、配送の重複を受信側で処理。AWS採用を意味しない。|
|T15|Unicode UAX 15|Unicode正規化形式を定義。互換正規化は原文を変える。|原文と検索キーを分離。読みや人物同一性の推定とは区別。|
|T16|PostgreSQL Constraints|CHECK・UNIQUE・FK・排他制約等と適用範囲を説明。|tenant/store/eventの複合FKと業務取引を併用。複数行合計を単純CHECKで済ませない。|
|T17|PostgreSQL Range Types|時刻範囲と排他制約で重複範囲を制御できる。|VIP物理テーブルを営業を跨いでも二重予約しない。[start,end)を採用。|
|T18|MDN IndexedDB|ブラウザ内のデータベースとトランザクション利用を説明。|当日最小スナップショットと暫定操作を分離。永続保存・遠隔削除の保証とはしない。|
|T19|RFC 9457|HTTP APIの機械可読なProblem Detailsを定義。|application/problem+jsonと独自code・trace_idで現場復旧に結び付ける。|
|T20|JSON Schema 2020-12|JSON文書の構造を記述・検証する枠組みを定義。|型と必須・enumをSchema化。時刻順・他店舗ID・枠合計は別検証。|
|T21|OWASP Authentication|認証、追加認証、試行制限などのガイダンス。|端末登録・権限拡張・返金・締めは本人管理セッションで追加認証。|

## 競合4社の今回再確認
|ID|対象|公式ページで確認した範囲|v4の評価|
|---|---|---|---|
|C01|QREW|ブラウザ受付、DJ・プロモーターQR、人数・売上、料金区分別バック計算|QRや精算単独の独自性を主張しない|
|C02|Clubble|予約・ゲスト・紹介者・決済・権限・集計の公開説明|v3の143要件は維持。競合の将来更新を自動で契約追加しない|
|C03|Vemos|検索可能なゲストリスト、スタッフ別フリー枠、時間料金、POS利用額|常連・枠・リアルタイムだけでは差がつかない|
|C04|GuestAccess|申請承認と入口一覧への反映、PIN付き受付リンク、当日追加|共有PINでの閲覧受付と、本人別通常承認の権限・証跡を比較する|

4社の実機、非公開プラン、日本の決済契約、性能は未確認。未記載を非対応とみなさない。他6社の情報は本体第13章にv3調査記録として継承。

## 差別化の検証設計
共用端末での担当者切替→到着前の入口通常承認→名前照合→部分入場→支払・紹介者実績までを同じ条件で比較する。比較は操作数、総所要時間、再連絡件数、精算訂正の4点。競合の広告上の秒数を実測値として扱わない。

## Evidence needed
端末OS・回線は実店試験。決済は事業者契約と試験取引。名前検索の候補誤選択率は匿名化データで検証。PINの手数と誤認証率は入口担当の交代試験。SLA・RPO/RTOは見積と復元訓練。

## Raw URLs

### T01 Mermaid ER diagram
https://mermaid.js.org/syntax/entityRelationshipDiagram.html

### T02 OpenAPI 3.1.1
https://spec.openapis.org/oas/v3.1.1.html

### T03 PostgreSQL Row Security
https://www.postgresql.org/docs/current/ddl-rowsecurity.html

### T04 PostgreSQL Explicit Locking
https://www.postgresql.org/docs/current/explicit-locking.html

### T05 PostgreSQL Transaction Isolation
https://www.postgresql.org/docs/current/transaction-iso.html

### T06 OWASP Session Management
https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html

### T07 OWASP Authorization
https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html

### T08 OWASP Password Storage
https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html

### T09 LINE Web Login
https://developers.line.biz/ja/docs/line-login/integrate-line-login/

### T10 WebKit Web Push
https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/

### T11 web.dev PWA installation
https://web.dev/learn/pwa/installation

### T12 Stripe webhooks
https://docs.stripe.com/webhooks

### T13 Stripe idempotency
https://docs.stripe.com/api/idempotent_requests

### T14 AWS transactional outbox
https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html

### T15 Unicode UAX 15
https://www.unicode.org/reports/tr15/

### T16 PostgreSQL Constraints
https://www.postgresql.org/docs/current/ddl-constraints.html

### T17 PostgreSQL Range Types
https://www.postgresql.org/docs/current/rangetypes.html

### T18 MDN IndexedDB
https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB

### T19 RFC 9457
https://www.rfc-editor.org/rfc/rfc9457.html

### T20 JSON Schema 2020-12
https://json-schema.org/draft/2020-12/json-schema-core

### T21 OWASP Authentication
https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html

### C01
https://hundred.jp/2026/07/28/services-update-app-ai/

### C02
https://clubble-booking.com/ja/

### C03
https://vemos.io/venue-management

### C04
https://guestaccess.nl/
