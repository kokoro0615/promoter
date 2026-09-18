# 調査根拠・採用判断・外部サービスの境界

確認日: 2026-09-19
対象: `kokoro0615/promoter` / 日本向けナイトクラブ管理SaaS
併読: `SWE2MAX_MASTER_PROMPT.md`

## この文書の位置付け

公開一次資料で確認した事実と、本案件で採用する設計判断を分ける。提供元の公開説明を確認したことは、その機能の実機検証、日本での加盟店審査通過、当該ユーザーのアカウントでの利用可能性を確認したことではない。

ユーザーは未定事項について推奨案の採用を委任している。一方、実店舗料金、報酬契約、実送金、課金を伴うクラウド契約、法務・税務の承認、実顧客への通知まで包括的に承認したものではない。以下は開発・ステージングの設計ベースラインである。

実装開始時に関連一次資料と実際のアカウント機能を再確認し、変化があればADRに記録する。変更理由なしに技術基盤を一から選び直したり、サービス未契約を理由に独立した機能実装を止めたりしない。

## 1. 未定事項の採用案

| 対象 | 採用する設計 | 未確定のまま保持する事項 |
|---|---|---|
| お客様の事前決済 | Stripe Connect direct chargesとStripe-hosted Checkoutを第一実装。各店舗の加盟店スコープで受け取り、SaaS利用料を分離する。 | 実業態の利用適格性、審査、契約、加盟店ごとの有効機能。 |
| 加盟店接続 | 新規構築はAccounts v2のSaaS向け構成を第一に検証。既存アカウントのOAuth接続は現行資料に従いv1の必要性を確認し、混在を隠さない。 | 実アカウントの種類、利用可能な構成、費用と損失の責任分担。 |
| VIP前払い | ミニマム額の事前決済を当日の対象注文へ充当する基本テンプレート。全額・一部・現地払いも設定可能。 | 実料金、対象商品、サービス料、税の取扱い、店舗契約。 |
| 取消・返金 | 期限別ルール、部分返金、人数変更、ノーショー、店舗都合取消を版管理し、購入時点の同意と条件を固定する。 | 実契約の取消料・期限・返金率の承認。未設定テンプレートは取消料0のDRAFT。 |
| 報酬 | 定額・対象売上歩合・段階・目標・チーム配分・上限を設定できる計算エンジン。手計算例と追跡可能な明細を必須にする。 | 実単価・率・雇用区分・源泉徴収・締め/支払契約。実銀行送金は今回行わない。 |
| POS・在庫 | 内製POS、商品事前購入、在庫、ボトルキープを全実装する。 | 特定の実店舗のPOS製品・ハードウェア。 |
| 外部POS参照実装 | SquareのSandbox対応サーバーAPIを使用。汎用CSVの移行・dry-run・再取込・照合も必須。 | POSアプリ、物理端末、Point of Sale APIの実機検証は別。 |
| 会計参照実装 | freee会計APIの開発用テスト事業所。対象事業所IDのallowlist、OAuth、重複防止、金額照合を実装。 | 実事業所の契約・勘定科目・税区分・会計承認。 |
| 個人ログイン | LINE Loginを主、メールリンクを代替。管理者・金銭等にはTOTPと回復コードによる追加認証。 | 実チャネル/送信元の所有者設定、資格情報。 |
| 通知 | アプリ内、Web Push、SESメールを必須とし、LINE Messaging APIを補助経路とする。 | 配信先同意、Official Account設定、実配送費、実通知の許可。 |
| SaaS課金 | 会社をテナント、店舗を基本課金単位。月額標準、年額・オプション・従量等も原本要件に対応。Stripe Billingを第一実装。 | 商用価格はUNSET。合成テスト価格を商用料金として公開しない。 |
| 個人情報 | 必要最小限、身分証画像・顔認識・マイナンバーは標準収集しない。目的、同意、閲覧、保持、削除を情報分類単位で管理。 | 正式な保持期間・プライバシーポリシー・法的保持・法務確認。 |
| 国・言語 | 日本、JPY、Asia/Tokyo。日本語を主、既存多言語要求への対応として日本国内利用の英語表示を維持。 | 海外店舗・海外法制・外貨決済は今回有効化しない。要件変更対応を明示する。 |
| UI/端末 | Web/PWAを再設計。スマホ・タブレット・PCに対応し、2D/一覧を3Dの代替として保持。 | 実端末OS/台数、実機Push・カメラ・復帰・通信品質。 |
| アプリ技術 | 適切な既存TypeScript/Fastify/PostgreSQL/React・Vite PWAを継続。workerは別プロセス。 | 必要な保守パッチ・実行環境との互換性は実測確認。 |
| インフラ | AWS東京: ECS Fargate、RDS PostgreSQL、S3、Secrets Manager、CloudWatch、SESを第一設計案とする。 | 現行料金による試算、予算と費用承認、既存契約環境の有無。 |
| 運用 | バックアップからの実復元、監視、再送、切戻し、導入・障害手順を作る。性能/復旧目標は測定して判定する。 | 本番当番、商用SLA、実店舗での受入、本番公開の承認。 |

これらは本案件の要件・既存実装・検証可能性に基づく選択であり、あらゆる店舗に対する絶対的な最適解という主張ではない。

## 2. 決済・課金で混同しない事項

### 店舗売上とプラットフォーム利用料

Direct chargesでは決済オブジェクトと残高が接続アカウントのスコープに属する。プラットフォームは接続店舗の正しいスコープで照会、Webhook処理、返金、照合を行う必要がある。[SRC-03]

これを採用する理由は「各店舗が自分の契約で受け取る」というユーザー決定への適合である。売上代金をプラットフォームが一括で受領して店舗に分配する方式に無断変更しない。各店舗の実契約が成立することまで保証するものではない。

### Accounts v2と従来のStandard接続

新規のSaaSプラットフォーム向け資料はAccounts v2を案内している。一方、既存アカウントへOAuthで接続する用途にはAccounts v1の制約がある。新規構築の資料と従来型Standard接続の資料を同じAPI仕様として混ぜない。[SRC-04][SRC-05]

実装時には、日本対応、利用できるDashboard、加盟店の本人確認、費用負担、負の残高責任、Webhookの形式を選定構成ごとに確認する。旧Standardを無条件の新規標準方式として固定しない。

### JPY銀行振込と自動口座引落

Stripeの銀行振込資料にはJPY、日本の事業者、Connect、Subscriptions、Invoicingの対応が記載される一方、Checkoutのsubscription/setup modeにおける銀行振込には非対応の制約がある。[SRC-07]

銀行振込は利用者が資金を送る方式であり、日本国内の自動口座引落と同じではない。原本の口座引落/銀行振込要求は別々に追跡する。日本に提供されていない海外向け口座引落手段を代用して完了としない。

国内口座引落が要件として必要な場合は、対応する国内サービスと契約・試験環境を調査し、アダプターと実接続の条件を記録する。実行可能な提供元テスト環境が得られなければ、その接続だけBLOCKEDにする。振込のコードを作っただけで口座引落も完了と報告してはならない。

### 業態審査

Stripeには禁止・制限対象の規定がある。[SRC-06] ナイトクラブという呼称だけで一律に可否を決めず、実際の営業形態、販売物、所在地、契約条件を確認する。加盟店審査における業態偽装、サービス名の変更による回避、承認前の実取引は禁止する。

## 3. 外部テストの意味

| サービス | 検証できること・注意点 |
|---|---|
| Stripe | 提供元のテスト環境で支払い、返金、Connect、Billing等を確認する。テスト成功は本番契約・実カード決済確認ではない。 |
| Square | Sandboxは対応APIのテストに使えるが、POSアプリ、物理端末、Point of Sale APIなどには非対応範囲がある。対応するサーバーAPIの実接続確認と実店舗のPOS試験を分離する。[SRC-11] |
| freee | 開発者向けテスト事業所を使う。架空のsandbox APIホストを作らず、公式手順と許可された事業所IDに従う。[SRC-12] |
| LINE Login | 許可されたチャネルとテスターで実認証する。表示名やメールの一致だけでアカウント紐付けをしない。[SRC-08] |
| LINE Messaging API | 送信可能な関係・条件がある。LINE Loginを使っただけで任意通知を送信できるとは限らない。テストアカウントの所有者・送信先同意を確認する。[SRC-09] |
| SES | Sandboxはリージョン単位の制約を持ち、検証済み宛先または所定のシミュレーターを使う。送信元・宛先をallowlistにする。[SRC-15] |
| Web Push | ブラウザ・OS・PWA状態による差を記録する。自動WebKit試験をiPhone実機での受信確認に置き換えない。 |

LINE Notifyは2025-03-31にサービス終了しているため、新規依存にしない。LINE通知を実装する場合はMessaging APIを用いる。[SRC-10]

## 4. 法務・個人情報・アクセシビリティ

個人情報保護委員会の通則編、消費者庁の通信販売に関する説明などを確認し、目的、同意、安全管理、販売者情報、購入最終確認、取消条件等の設計要件へ対応させる。[SRC-16][SRC-17]

特定の保持年限、キャンセル料、税区分の妥当性は、当該店舗の業務・契約・保存対象に依存する。これらのサイトを引用しただけで個別の法務・税務レビューが完了したとしない。税表示・請求書・会計要件は、実装時に対象業務に即した国税庁等の現行一次資料も補足する。

WCAG 2.2 AAをUI設計の目標にする。ただし自動検査の合格だけで全基準への適合を保証せず、キーボード操作、ラベル、フォーカス、色以外の状態表現等を手動確認と組み合わせる。[SRC-18]

## 5. Devin CLIでのモデル選択

公式資料にはモデルセレクター `/model`、利用可能モデル一覧 `devin models list` がある。[SRC-01][SRC-02] これはユーザーのアカウントでSWE-2maxが必ず利用可能という証明ではない。実際の一覧で確認し、存在しないモデルIDや架空のmaxフラグを指定しない。

CLIの利用モデル/推論設定とプロンプトを分離する。この指示書を渡しても契約・権限・CLI制限を超えて作業できるようにはならない。制限がある場合は正確に記録し、成果物と再開手順を保存する。

## 6. 予備確認したリポジトリの状態

確認対象main: `95fddf6dd5c059c1b0ab39fb5af83633fc1fecea`

今回の作業は指示書作成のための予備確認であり、全コードレビューやアプリ試験の再実行ではない。

- `nightclub-app/docs/execution/status.json`: R1 verifiedという表記と、実認証・決済・UI拡充・R4等の残作業が併存。`last_verified_commit` はnull。
- `nightclub-app/package.json`: `verify`にはE2E、全ビルド、OpenAPIの個別コマンドが含まれていない。`lint`はTypeScriptの型確認。
- `nightclub-app/vite.config.ts`: manifestのiconsが空、更新方式autoUpdate。PWAの導入/更新と現場操作の保全をレビュー対象にした。
- `nightclub-app/src/server/routes/finance.ts`: 現金/外部端末記録とPSP経路の境界、金額の検証、配賦、返金を全面監査の対象にした。今回だけで全欠陥の存在を断定していない。
- 原本の143機能/145詳細要件/104試験/28 Epicは別集合。実装担当に実ファイルでの再集計と追跡を要求した。

## 7. 一次資料一覧

以下は2026-09-19に確認した公開資料の所在。提供元が更新するため、実装時には対象部分の確認日、必要なAPI版、引用箇所を台帳に残す。短い根拠メモとURLを保存し、第三者ページ全体や画像を無断でリポジトリへ転載しない。

| ID | 提供元・資料 | URL | 用途 |
|---|---|---|---|
| SRC-01 | Devin CLI Models | `https://docs.devin.ai/cli/models` | モデル選択、実際の利用可能モデル確認。 |
| SRC-02 | Devin CLI Commands | `https://docs.devin.ai/cli/reference/commands` | モデル一覧、CLI/セッション操作。 |
| SRC-03 | Stripe Direct charges / hosted Checkout | `https://docs.stripe.com/connect/direct-charges?platform=web&ui=stripe-hosted` | 店舗アカウントの決済スコープとCheckout。 |
| SRC-04 | Stripe Accounts v2 SaaS payments and billing | `https://docs.stripe.com/connect/accounts-v2/saas-platform-payments-billing` | 新規構成と決済/利用料の境界。 |
| SRC-05 | Stripe Standard accounts | `https://docs.stripe.com/connect/standard-accounts` | 従来方式、既存アカウント接続、v2との区別。 |
| SRC-06 | Stripe Japan restricted businesses | `https://stripe.com/jp/legal/restricted-businesses` | 業態・加盟店審査の条件。 |
| SRC-07 | Stripe Bank transfers | `https://docs.stripe.com/payments/bank-transfers` | JPY振込、対応方式・非対応Checkout mode。 |
| SRC-08 | LINE Login Web integration | `https://developers.line.biz/ja/docs/line-login/integrate-line-login/` | 認証フローと検証。 |
| SRC-09 | LINE Messaging API sending messages | `https://developers.line.biz/ja/docs/messaging-api/sending-messages/` | 通知経路と送信可能条件。 |
| SRC-10 | LINE Notify終了案内 | `https://notify-bot.line.me/ja/` | 終了済みサービスへの新規依存を回避。 |
| SRC-11 | Square Sandbox overview | `https://developer.squareup.com/docs/devtools/sandbox/overview` | 外部API試験とPOS実機非対応範囲。 |
| SRC-12 | freee Developers start guide | `https://developer.freee.co.jp/startguide` | 開発用テスト事業所・OAuth。 |
| SRC-13 | AWS ECS Fargate | `https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html` | API/workerのコンテナ実行案。 |
| SRC-14 | AWS RDS point-in-time restore | `https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PIT.html` | 復元設計・実訓練。 |
| SRC-15 | AWS SES production access / sandbox | `https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html` | ステージング送信制限。 |
| SRC-16 | 個人情報保護委員会・通則編 | `https://www.ppc.go.jp/personalinfo/legal/guidelines_tsusoku/` | 個人情報取扱いの設計確認。 |
| SRC-17 | 消費者庁・通信販売 | `https://www.no-trouble.caa.go.jp/what/mailorder/` | 販売者表示・取引条件等の確認。 |
| SRC-18 | W3C WCAG 2.2 | `https://www.w3.org/TR/WCAG22/` | アクセシビリティ設計目標。 |
| SRC-19 | Clubble日本語公式サイト | `https://clubble-booking.com/ja/` | 公開機能/Coming Soonとの機能比較。 |

## 8. Clubble比較の範囲

公式公開ページを機能比較の根拠とする。[SRC-19] 予約、フロア、スタッフ/紹介者、受付、決済、通知、運営管理等の公開記載に加え、3D、貸切関連、商品事前購入、一般入場の事前決済、イベントチケット、POS/在庫等のComing Soon記載も対象として追跡する。

公開記載の網羅と、非公開画面/内部アルゴリズムの完全互換は別物である。存在が確認できない内部仕様は推測して競合の事実としない。広告上の効果、精度、処理能力を自社の達成済み性能へ転記しない。

主指示書のF01〜F22は本案件の独自業務設計を含む分類であり、競合の文面を複製した機能仕様ではない。Clubble由来、旧要件由来、ユーザー決定、自社追加設計の由来を要件台帳で区別する。
