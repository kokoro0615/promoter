# Nightclub v4｜SWE-2へ渡す開発スターター

作成日：2026-09-16 / 指示書版：1.0

## Summary

v4開発パッケージの原本と、実装・検証・再開・最終検収の指示を一つにまとめた提出物です。業務要件をv5へ更新したものではありません。

**推奨：このフォルダーを開発ワークスペースとして開き、START_HERE.txtをSWE-2へ送って開始します。** 読み取りだけのチャットではなく、ファイル編集・コマンド実行・DB・ブラウザ確認を行える開発環境を使用する前提です。

全体対象はR1〜R4。R1を最初に完結させ、後続を依存関係・詳細設計に沿って進めます。外部接続先、実料金、実端末、店舗受入、本番公開は開発コードの完成と分けて判定します。

## ファイル

|ファイル|役割|
|---|---|
|[SWE2_MASTER_PROMPT.md](SWE2_MASTER_PROMPT.md)|全実行指示。要件参照、実装順、禁止事項、試験、進捗保存、完了・公開の判定|
|[START_HERE.txt](START_HERE.txt)|最初に送る短い起動指示。マスタープロンプトの全文読込と実作業開始を指定|
|[AGENTS.md](AGENTS.md)|継続して参照する要点。業務不変条件、原本保全、権限、実証、再開|
|[RESUME_PROMPT.txt](RESUME_PROMPT.txt)|中断・新しいセッションからの再開。既存コードと証跡を確認し続きから実行|
|[FINAL_AUDIT_PROMPT.txt](FINAL_AUDIT_PROMPT.txt)|納品前に独立したレビューと実行検証・修正を依頼|
|[PROMPT_VERIFICATION.md](PROMPT_VERIFICATION.md)|原本との対応、検査結果、未検証事項、公式参照URL|
|[Nightclub_v4_Development_Package/README.md](Nightclub_v4_Development_Package/README.md)|元のv4全91ファイル。内容を変更せず収録|

## 導入手順

1. **利用者／開始前：** ZIPを展開し、このREADMEとSWE2_MASTER_PROMPT.mdがある階層を開発環境で開く。完了条件は、ルートの指示書とNightclub_v4_Development_Package配下を読み取れること。
2. **利用者／初回実行時：** SWE-2を選択し、START_HERE.txtを送る。通常の開発操作を実行できる権限を設定するが、本番や実課金を無条件許可しない。
3. **実装担当／各段階：** docs/execution/へ実装・試験結果・残件を保存する。完了条件はコード・API・DB・試験・証跡が要件IDへ接続されていること。
4. **店舗責任者・検証担当／公開前：** 料金、担当者、PSP契約、実端末、復元、限定営業などを実確認する。未確認項目がある限り該当の公開ゲートは維持する。

START_HEREは短縮版の全要件ではありません。同じワークスペースにマスターと原本が必要です。マスターだけをチャットへ貼る場合も、元パッケージを読み取れる状態にしてください。

## 既存リポジトリを使う場合

新規なら同梱フォルダーをそのままワークスペースにできます。既存アプリがある場合は、そのGitリポジトリの中へ指示書・原本を置き、既存コードから実装を続けます。既存のAGENTS.md、README、設定、未コミット変更を丸ごと上書きしないでください。AGENTS.mdは適用範囲・優先順位を確認して必要部分を追記し、マスターの場所を明記します。

原本のNightclub_v4_Development_Packageは読み取り用。コードや改訂契約をその中へ直接追加・上書きせず、アプリ側のファイルと実装版の契約を別に管理します。

## 実行中の3ケース

**ケースA：PSPが未選定。** 受付、設定、VIP在庫、金銭ドメイン、アダプター契約と合成試験を進めます。特定PSPの正式採用を推定せず、製品固有接続と実決済をBLOCKEDにします。モックで確認した結果をPSP確認済みにしません。

**ケースB：作業セッションが終了。** 新しいセッションへRESUME_PROMPT.txtを送ります。status.json、resume.md、Git差分、直近試験から続け、正常な既存実装を最初から作り直しません。

**ケースC：R1が動いた。** R1の技術試験と実機・店舗受入を分けて判定します。R2〜R4を消したり「全体100%」にしたりせず、詳細設計・依存が整った作業へ進みます。4営業の現場検証をE2E4回で代替しません。

## 完了として受け取るもの

実行可能なコード、DB migration・RLS・取引、API・ERの現行版、試験・CI、合成seed、実行済み起動コマンド、操作説明、復元・rollback手順、Release別達成表、外部待ち、実証済みURLまたはローカル確認経路を受け取ります。

**「完遂」の判定は証跡で行います。** 指示書を送ったこと自体は、実装完了や本番稼働を意味しません。最終判定前にはFINAL_AUDIT_PROMPT.txtで要件・コード・試験・実行環境を再確認します。

## 前提と確認区分

FACT / Confidence：High：原本のv4にある採用方針・対象を参照し、その原本を変更せず同梱しています。詳細はPROMPT_VERIFICATION.md。

INFERENCE / Confidence：Medium：マスター＋短い継続ルール＋進捗ファイルの構成は、この大きな開発対象を管理するための実行設計です。自律遂行率・所要時間・コストは実測していません。

Evidence needed：利用環境でのSWE-2選択、ワークスペース読取、DB/ブラウザ/コマンド実行、対象クラウド権限、アプリ実試験。Phase 0と実装後の受入で確認します。

## 公式参照URL

SWE-2の公開・提供環境、およびAGENTS.mdの取扱いを以下の公式資料で確認しています。利用アカウントの契約・残量・権限を確認したものではありません。価格・ベンチマークを本開発の完了保証へ転用していません。

https://cognition.com/blog/swe-2
https://docs.devin.ai/onboard-devin/agents-md
https://docs.devin.ai/desktop/cascade/agents-md
https://docs.devin.ai/cli/extensibility/rules
https://docs.windsurf.com/ja/windsurf/cascade/agents-md
