# Nightclub App — agent notes

TypeScript + Fastify 5 + node-postgres + React 19 (Vite PWA) + Vitest + Playwright.
PostgreSQL 16.2 runs from bundled `pgserver` binaries via `tools/devdb.mjs`.

## Commands

- `pnpm devdb:start` — embedded PostgreSQL on 127.0.0.1:55432
- `pnpm db:reset && pnpm db:seed` — drop/migrate/seed `nightclub_dev` (writes `devdb/seed.json`)
- `pnpm db:backup` / `pnpm db:restore <file>` — pg_dump/pg_restore via bundled binaries
- `pnpm dev:api` / `pnpm dev:worker` / `pnpm dev:web` — API :8787, worker, Vite :5173 (proxy `/api`)
- `pnpm verify` — lint (tsc) + unit + db/RLS + API tests (resets & seeds `nightclub_test`)
- `pnpm test:e2e` — Playwright smoke (auto-starts api+web; needs seeded dev DB)
- `pnpm openapi:lint` — redocly against `spec/current/openapi.yaml` (package contract copy)

## Conventions

- Migrations: numbered SQL in `db/migrations/`, checksums enforced — after editing an
  applied migration you must `pnpm db:reset`.
- Runtime authz = PostgreSQL GUCs set per request (`src/server/lib/ctx.ts`) + RLS
  policies (`db/migrations/0002_app_runtime.sql`). Never query with superuser.
- Command routes use `withReceipt(...)` and MUST apply `reply.code(res.httpStatus)`
  — business rejections are committed as REJECTED receipts, not thrown.
- Entrance approval needs only operator session + assignment + permission.
  Do NOT add absence/wait/arrival/read-receipt preconditions (user requirement).
- Name search is never identity proof; identity = `customer_checks` rows.
- Dev login `POST /api/auth/dev/login` requires `DEV_AUTH=1` and non-production.
- Seed subjects for dev login: `admin`, `promoter`, `door`, `approver`, `rival`.

## Status / docs

- Progress & evidence: `docs/execution/status.json`, `docs/execution/decisions.md`,
  `docs/execution/blockers.md`, `docs/execution/evidence/`.
- Source package (read-only original): `Nightclub_v4_Development_Package` under the
  handoff directory.
