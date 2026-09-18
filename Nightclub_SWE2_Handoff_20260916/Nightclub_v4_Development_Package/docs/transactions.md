# コマンド・同時操作・不変条件 v4

**設計案／Confidence：Medium。** 参照DDLは形の一部を制約化するが、この処理自体を実装したSQL関数・バックエンドは同梱していない。

## 1. 共通コマンド契約

認証由来のactor、store、event、device、operator contextを取得→入力の許可列だけ検証→同一操作キーを照会→リクエストハッシュ一致なら保存済み結果を返す→権限と対象版を検証→必要な行を固定順でロック→業務不変条件を確認→状態・台帳・監査・Outbox・成功receiptを同一取引でcommit。[T04][T14]

Idempotency-Keyの一意範囲はtenant/store/actor_key/operation_name/key。キー流用でpayloadが違う場合409 IDEMPOTENCY_CONFLICT。PROCESSINGの同じ要求は409 COMMAND_IN_PROGRESSと再照会経路。永久台帳のsource_key・PSP参照はHTTPキーの保持期限より長く残し、期限後再送の二重請求を防ぐ。失効したactorへ保存済み個人情報を無条件に返さない。[T13]

## 2. ロック順（実装の共通規約）

対象device→有効membership（複数ならID順）→営業event_stream_head（複数ならID順）→visit→segment→approval_request→quota_bucket（ID順）→booking/table allocation→sales_order/payment（ID順）。処理が前段を必要としない場合は飛ばせるが逆順取得しない。権限停止・担当交代・設定公開も同じ規約に参加する。

イベント横断のtable在庫はPostgreSQL排他制約と物理tableのロックで追加保護する。異なる営業が同じテーブルを取る場合に各営業ロックだけでは防げない。排他競合を409 TABLE_UNAVAILABLEへ変換する。[T17]

デッドロック／serialization failureは取引全体を上限付き再試行し、UIへ部分成功を見せない。外部決済・メール・大きな帳票処理はロック外。性能は実負荷で検証する。

## 3. 主要取引

|TX|処理|同じcommitに含めること|
|---|---|---|
|TX-01 登録・省略|紹介者／入力者を別保存し設定版・許可を判定|visit、segments、確定分quota、必要時requests、audit、outbox、receipt|
|TX-02 手動承認|PENDING、版、自己申請、指定／入口権限、上限を確認|decision 1件、request終端、segment、quota、audit、outbox、receipt|
|TX-03 実入場|最新版・残人数・本人照合・支払未充当残高を確認|entry ledger、segment count、quota held→consumed、必要な売上行・入金充当、pass、audit、outbox、receipt|
|TX-04 取消・減員|入場済みと未入場を分離|未入場引当返却、segment版、request supersede、audit、outbox|
|TX-05 設定公開|preview/token/versionと影響を再照合|新policy、適用対象再審査、quota整合、audit、outbox|
|TX-06 担当交代|有効deviceとPIN・当日役割確認|旧operator終了、epoch+1、新session、監査|
|TX-07 VIP押さえ|table/timeと準備時間、capacity確認|booking、physical table allocations、visit、audit、outbox|
|TX-08 決済反映|署名済みinbox、merchant/amount/currency/bookingを照合|payment結果、利用可能在庫ならbooking確定、例外ならPAYMENT_EXCEPTION、outbox|
|TX-09 営業締め|未同期・未照合・未配分と例外理由を確認|settlement版、根拠明細、イベント締め、audit、outbox|

## 4. 先着一決定

承認者Aと入口Bが同時に同じ申請を判断したら、request行ロック後に状態・版を再評価。先に成功した決定1件が正。後続は409 ALREADY_DECIDEDと閲覧可能な結果を返す。APPROVEDだけでなくREJECTED／RETURNEDも終端。旧画面の承認で上書きしない。差戻し再提出は新request行と版で行う。

通常入口承認はENTRANCE経路であり緊急例外ではない。指定者不在・経過時間・到着済みを条件にしない。入口が承認してもreferrer_idは変えない。

## 5. 承認と入場は別

R1は別コマンド。承認成功後、同じ画面で本人照合・支払を確認して入場。入場だけ失敗したら「承認済み・未入場」。再送するのは入場操作のみ。ネットワーク結果不明では同じ操作キーで状態を照会し、新しいキーで同じ料金を再請求しない。

## 6. DDL以外に必須の不変条件

- 1回の入場選択数は全て正、同じsegment_idの重複選択なし。first_enteredはauthorized以下。
- customer_checkは同じ顧客・来店・営業に有効。選択済み氏名だけを照合済みとしない。
- 顧客許可の本人・同行者条件と、来店した本人の確認を検証。未確認者の枠を本人へ振り替えない。
- quota_bucketのheld/consumedと各allocationの和が一致。最大枠を同時操作で超えない。
- paymentごとの成功金額−成功/処理中返金−有効充当は負数不可。返金処理中も利用可能残高から予約する。
- sales_order・sales_line・payment・allocationの通貨、来店、PSP店舗を照合。
- 紹介者売上配分を有効化した場合、売上行の同じ確定版で合計10000bp。R1は主紹介者10000bp。
- 訂正・返金・入場取消と現実に店内へ入った事実を混同しない。未照合は暫定として残す。

CHECKは他行合計を直接保証しない。[T16] コマンド層と整合性検査SQLの実装・受入試験を必須にする。raw DDLが読めたことをこれらの合格にしない。
