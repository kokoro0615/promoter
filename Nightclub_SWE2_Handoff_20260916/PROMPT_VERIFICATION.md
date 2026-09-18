# SWE-2実行指示｜根拠・レビュー・提出前検証

作成日：2026-09-16 / 指示書版：1.0

## 1. 適用範囲

この提出物は開発を実行するためのプロンプトと引継ぎ構成です。アプリ実装、SWE-2での試走、実機、PSP、本番公開の完了を意味しません。

FACT / Confidence：High：元のv4を読み取り、原本91ファイルを同一内容で収録。入力参照、件数、原本ハッシュ、起動・再開指示の整合を検査しました。

INFERENCE / Confidence：Medium：実装順のまとめ、継続ルール、docs/execution/の状態保存、最終検収プロンプトは、今回追加した実行設計です。v4の業務方針や公開ゲートを勝手に確定し直すものではありません。

Evidence needed：実際のSWE-2環境で、指示が読み込まれ、作業・試験・再開・報告へ反映されること。Phase 0と、実装中の要件ID・試験証跡・再開ファイルで確認します。自律完遂率、開発時間、費用は未計測です。

## 2. v4との対応

|プロンプトの重要指示|原本の根拠|今回の扱い|
|---|---|---|
|常連はお客様、名前検索中心、入口通常承認、共用端末|README.md、docs/requirements_v4.md、CHANGELOG.md|採用済みを維持|
|待機時間・不在確認・来店前提を入口承認に追加しない|docs/shared_device_auth.md 第5節、docs/transactions.md 第4節|v3・途中案への回帰を禁止|
|共用端末でも個人を識別し、旧タブを新担当へ付け替えない|docs/shared_device_auth.md 第1〜4節、V4-KSK群|詳細設計案の実装と試験を要求|
|設定値をハードコードしない。空欄≠無制限|docs/settings_and_rules.md 第1・3・5節、D-02|合成試験と本番設定を分離|
|R1〜R4を保持。R1で全体完了にしない|planning/backlog.csv、planning/legacy_143_traceability.csv、本文第2章|全体対象と段階依存を維持|
|参照DDLを実装済みとみなさない|db/README.md、validation/report.md|実DB・RLS・コマンド・並列試験を要求|
|API不足とR2〜R4の詳細を対象実装前に補完|api/coverage.md、docs/developer_handoff.md|DoR・変更IDを追加して進める|
|原本104試験を保持し後続の包括試験を分解|tests/acceptance_cases.csv、tests/README.md|原本の粒度不足を黙って合格にせず子試験追加|
|PSP・契約・運用承認を推定しない|planning/decision_register.csv D-05〜D-11|該当機能/公開のゲートを維持|
|工程ごとの実行、再開状態、独立レビュー|今回の実行設計|業務要件の追加ではなく、実装遂行の管理方法|

## 3. 実施した検査

|検査|結果|対象と限界|
|---|---|---|
|元ZIPとのバイト比較|PASS|原本91ファイルが全て一致|
|元のMANIFEST.sha256|PASS|記載90ファイル全て一致。manifest自身は元リストの対象外|
|入力件数の再集計|PASS|143機能、145詳細、104受入、28Epicを各CSVから再集計|
|Release別受入の確認|PASS|R1=101、R2/R3/R4=各1。後続の全検証が十分という評価ではない|
|マスターの明示入力参照|PASS|36ファイルの実在と記載を確認。生成予定のdocs/execution/等は入力と区別|
|未置換の入力欄・文字化け|PASS|調査対象のプレースホルダーと置換文字なし。PACKAGE_ROOTは実行時に発見して定義|
|起動・継続・再開と主要統制の記載|PASS|マスター参照、R1〜R4、入口通常承認、原本保全、証跡、本番ゲートを確認|
|v4の静的検査の再実行|PASS|隔離コピーでvalidate_package.pyの7検査群が成功。Mermaidは既存描画記録の点検で、今回の再描画ではない|
|v4の参照単体試験の再実行|PASS|隔離コピーでreference_checks.pyの13件が成功。実アプリ・DB並列試験ではない|
|READMEのローカル参照|PASS|リンク先が今回の同梱ファイルと一致|
|SWE-2への実投入|NOT_RUN|利用環境・アカウントでの実行をこの提出作業では行っていない|
|アプリ・実DB・実機・PSP|NOT_RUN|プロンプト作成であって、アプリ開発完了の検収ではない|

## 4. レビューで重視した欠陥と反映

**範囲の勝手な縮小：** R1で終了して全体完成とする指示を排除し、R2〜R4の対象と依存・DoRを維持しました。詳細が未定の業務判断を創作せず、先行可能な作業だけを明示分割します。

**権限・本番ゲートの混同：** ローカル/隔離開発の実行と、契約・実決済・公開の許可を分けました。資格情報があるだけで本番操作を開始しない指示を入れています。

**試験仕様を合格と取り違える：** 原本104件のNOT_RUNを保持し、実行環境・コマンド・exit code・期待/実値・証跡から更新する指示にしています。R2〜R4は包括試験だけではなく子試験を要求します。

**共用端末で操作主体が変わる：** operator context、交代とコマンドの取引境界、旧タブ拒否を再確認対象にしました。

**原本検証で原本が変わる：** 元のスクリプトが検査ログを更新するため、隔離コピーでの再実行を指示しました。アプリ側の現行契約と入力ベースラインは別に管理します。

**中断すると再設計からやり直す：** 進捗、決定、阻害、要件対応、試験結果、再開コマンドを実ファイルへ保存し、再開時にGit差分と照合する方式です。

## 5. 入力ZIPの同一性

ファイル：Nightclub_v4_Development_Package_20260915.zip

SHA-256：`26189231a39ff5459b29ae68d33f86724d1b2e157c1b037352e54adec637a322`

この値は受領済みZIPの照合値であり、アプリの安全性・品質の証明ではありません。原本のMANIFESTを実装版へ流用せず、実装後はcommitとCI成果物で版を管理します。

## 6. 指示ファイルのSHA-256

この検証報告自身を除いた追加6ファイルの照合値です。

|ファイル|SHA-256|
|---|---|
| `AGENTS.md` | `add3568ad0b87413f19dd0049906cb427c415e37c74b302c6559682bb6d85fef` |
| `FINAL_AUDIT_PROMPT.txt` | `fbb97af2c954b4c2b0de244269b85b51a89a96685f058f4ac57217fff8782a19` |
| `README_SWE2.md` | `c5515a2d96bf027a625f96e50e8f96ca6ed012751191c532cae4be2a460fc95b` |
| `RESUME_PROMPT.txt` | `8fe576458325a273d51a6fdc2294c4610296d76c7cb57bfca5d66f7af584e4e8` |
| `START_HERE.txt` | `45739f2b61d697b48c621a7574a3b6c19c2d5ab29cd6d76d4240d075b9a565b7` |
| `SWE2_MASTER_PROMPT.md` | `2ec60b146bef3e4c6c6b46730072c0caa2696b3a5c1cc10dc67e9ef88ad74254` |

## 7. 公式資料の確認範囲

2026-09-16に、SWE-2の提供元の公開資料、およびDevinのAGENTS.md・CLIのルール仕様を確認しました。ルートに短い継続指示を置き、詳細を別のマスターファイルへ分離する構成にしています。WindsurfのAGENTS.md資料も参照しています。

提供元の性能評価を、このアプリの成功率・所要時間・品質保証へ転用していません。個別アカウントで使える機能・課金・権限・自動実行設定は、Phase 0で別に確認します。

原文URL：

https://cognition.com/blog/swe-2
https://docs.devin.ai/onboard-devin/agents-md
https://docs.devin.ai/desktop/cascade/agents-md
https://docs.devin.ai/cli/extensibility/rules
https://docs.windsurf.com/ja/windsurf/cascade/agents-md
