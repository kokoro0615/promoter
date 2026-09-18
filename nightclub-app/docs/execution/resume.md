# Resume guide — v5 Japan completion

Last updated: 2026-09-19 (Phase 4 close-out)
Branch: `feat/v5-jp-completion` (repo root `/home/kokoro/projects/clients/promoter`)

## How to resume

1. `cd /home/kokoro/projects/clients/promoter/nightclub-app`
2. `pnpm devdb:start` — embedded PostgreSQL on 127.0.0.1:55432
3. `pnpm db:reset && pnpm db:seed` — recreate + seed `nightclub_dev` (writes `devdb/seed.json`)
4. `pnpm verify` — lint + unit + db/RLS + api tests (auto-resets `nightclub_test`)
5. `pnpm test:e2e` — Playwright (auto-starts api+web; needs seeded dev DB)
6. `pnpm openapi:lint` — spec contract check
7. `pnpm build` — frontend production build (tsc build config + vite + PWA)

State of record: `docs/execution/status.json`, `docs/execution/findings.json`,
`docs/execution/requirements_registry.json`, `docs/execution/blockers.md`.

## Current state (verified 2026-09-19 @ 8cfd8f6)

- unit 9 / db 7 / api 114 (r1:16 r2r3:18 vip:8 security:13 v5endpoints:35
  authalt:11 publicbook:3 concurrency:3 parity:7) / e2e 3 / vite build — all pass
- spec parity: 75/78 contract ops implemented; remaining 3 are documented
  intentional divergences (`docs/execution/api_parity.txt`)
- ER model regenerated: `pnpm model:summary` → `docs/execution/model_summary.txt`
- evidence: `docs/execution/evidence/phase9_verify_20260919.txt`

## Shipped phases

- 3a `517529e` — VIP checkout/webhook money path + 6 audit bugs (api 42)
- 3b `f55d00a` — runtime schemas, CSRF guard, rate limits, security headers (api 55)
- 3c `06094cf` — v5 missing endpoints + regression suite (api 90)
- 3d `2db9535` — email-link auth, TOTP/recovery/step-up, PSP adapter+stripe seam (api 101)
- 4a `4901805` — public booking pages: slug lookup + APPROVAL_PENDING submissions (api 104)
- 4b `93a4ec2` — role-view frontend redesign: login/MFA, promoter, kiosk,
  admin 12 tabs, platform console, public booking form (e2e 3)
- 5 `292c772` — concurrency races (stock oversell, same-key parallel,
  approval first-wins) + phase-4 read-field assertions (api 107)
- 9 `8cfd8f6` — contract parity: segment replace, visit attribution,
  order lines, templates, coupons, notification-templates, imports +
  ER/api_parity generators + basis_points 0→10000 fix (api 114)

## Phase 1 audit result

32 findings recorded in `findings.json`; F-001..F-032 fixed through Phase 4
(F-029 open = remaining scope). Highest-priority real bugs were the money
path (F-001), PROCESSING receipt reclaim (F-005), and CSRF/rate-limit (F-008/9).

## Work order (remaining)

PR #2 open on GitHub (feat/v5-jp-completion -> main, verified via `gh pr view` 2026-09-19):
https://github.com/kokoro0615/promoter/pull/2 — review/merge + staging handoff.
Optional depth: more E2E beyond the 3 smoke paths; tenant import job
execution (B-06); ticket QR display; 3D floor map.
External-credential work stays BLOCKED behind adapter seams (see blockers.md):
PSP contract (B-01), LINE OIDC (B-02), mail delivery for email-link (B-11).

## Invariants (do not regress)

- Name search is never identity proof; `customer_checks` is the only proof.
- Entrance approval needs only operator session + assignment + permission —
  never add absence/wait/arrival/read-receipt gates.
- Same-name customers stay distinct rows forever.
- UNSET / LIMITED 0 / UNLIMITED are three different things.
- Command routes use `withReceipt` + `reply.code(res.httpStatus)`; business
  rejections commit REJECTED receipts.
- Never query as superuser; runtime is `app_runtime` + GUCs + RLS.
- Migrations are checksummed — new schema = new numbered migration file.
- Dev issuer requires `DEV_AUTH=1` and non-production.

## Environment

node v24.19.0, pnpm 11.22.0, PG 16.2 bundled (tools/devdb.mjs),
Playwright chromium-headless-shell v1243, no docker, no sudo.
