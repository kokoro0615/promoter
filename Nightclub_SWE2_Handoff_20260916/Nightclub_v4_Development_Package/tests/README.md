# テストパッケージ

受入試験は**104件**（v3継承60件＋v4追加44件）。すべて **NOT_RUN**。設計文書に記載しただけで合格としない。

`acceptance_cases.csv`に前提、操作、合格条件、要件ID、Release、担当と証跡欄を収録。`critical_flows.feature`は重点ケースのGherkinで、step definitions・実アプリとの接続は未実装。

`reference_checks.py`は正規化・設定・例示計算の参照テストであり、DB競合やアプリ動作を検証するものではない。`python tests/reference_checks.py`で実行する。実際の結果はvalidationフォルダに区別して保存。

DB・RLS・PSP・ブラウザ・負荷・障害・復元の試験は対象実装が必要。スナップショットの順序試験は遅延COMMIT/ROLLBACKを制御し、単なる順次API実行で代替しない。
