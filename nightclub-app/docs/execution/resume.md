# Resume guide — v5 Japan completion

Last updated: 2026-09-19 (Phase 0/1 close-out)
Branch: `feat/v5-jp-completion` (repo root `/home/kokoro/projects/clients/promoter`)

## How to resume

1. `cd /home/kokoro/projects/clients/promoter/nightclub-app`
2. `pnpm devdb:start` — embedded PostgreSQL on 127.0.0.1:55432
3. `pnpm db:reset && pnpm db:seed` — recreate + seed `nightclub_dev` (writes `devdb/seed.json`)
4. `pnpm verify` — lint + unit + db/RLS + api tests (auto-resets `nightclub_test`)
5. `pnpm test:e2e` — Playwright (auto-starts api+web; needs seeded dev DB)
6. `pnpm openapi:lint` — spec contract check

State of record: `docs/execution/status.json`, `docs/execution/findings.json`,
`docs/execution/requirements_registry.json`, `docs/execution/blockers.md`.

## Current baseline (verified 2026-09-19 @ 58e9438)

- unit 9 / db 7 / api 34 (r1=16, r2r3=18) / e2e 3 — all pass
- worker export job verified; build+openapi lint pass

## Phase 1 audit result

30 findings recorded in `findings.json`. Highest-priority real bugs:
F-001 (webhook never confirms bookings + cross-booking allocation confirm),
F-002 (my-performance broken join), F-004 (move 500 on PAYMENT_PENDING),
F-005 (PROCESSING receipt never reclaimed), F-006 (CSV formula injection),
F-007 (no runtime validation), F-008 (no CSRF guard), F-009 (no rate limits).

## Work order (do not skip phases)

Phase 3 foundation fixes → missing endpoints/migration 0004 → auth alternatives
→ public booking → UI role redesign → tests per vertical → docs/OpenAPI → PR.
External-credential work stays BLOCKED behind adapter seams (see blockers.md).

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
