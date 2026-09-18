#!/usr/bin/env tsx
// migrate.ts - apply db/migrations/*.sql in order with checksum drift detection.
// Each migration file manages its own transaction (BEGIN/COMMIT).
// Usage:
//   tsx tools/migrate.ts              apply pending migrations
//   tsx tools/migrate.ts --reset      drop schema + bookkeeping, reapply all
//   tsx tools/migrate.ts --status     list applied/pending
// Env: DATABASE_URL (default: devdb nightclub_dev)
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const DIR = join(ROOT, 'db/migrations');
const LOCK_KEY = 721777;
const DEFAULT_URL = 'postgresql://postgres@127.0.0.1:55432/nightclub_dev';

const args = process.argv.slice(2);
const url = process.env.DATABASE_URL || DEFAULT_URL;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function main() {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS public.nc_schema_migrations (
      version text PRIMARY KEY, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`);

    if (args.includes('--reset')) {
      console.log('reset: dropping schema nightclub + bookkeeping');
      await client.query('DROP SCHEMA IF EXISTS nightclub CASCADE');
      await client.query('DELETE FROM public.nc_schema_migrations');
    }

    const applied = new Map<string, string>();
    for (const r of (await client.query(
      'SELECT version, sha256 FROM public.nc_schema_migrations')).rows) {
      applied.set(r.version, r.sha256);
    }

    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    const pending: string[] = [];
    for (const f of files) {
      const sql = readFileSync(join(DIR, f), 'utf8');
      const h = sha(sql);
      if (applied.has(f)) {
        if (applied.get(f) !== h) {
          throw new Error(`migration drift: ${f} sha mismatch (applied=${applied.get(f)}, file=${h})`);
        }
        continue;
      }
      pending.push(f);
    }

    if (args.includes('--status')) {
      for (const f of files) console.log(`${applied.has(f) ? 'applied' : 'PENDING'}  ${f}`);
      return;
    }

    for (const f of pending) {
      const sql = readFileSync(join(DIR, f), 'utf8');
      console.log(`applying ${f} ...`);
      const t0 = Date.now();
      try {
        await client.query(sql);
      } catch (e) {
        console.error(`FAILED ${f}:`, (e as Error).message);
        process.exitCode = 1;
        return;
      }
      await client.query(
        'INSERT INTO public.nc_schema_migrations (version, sha256) VALUES ($1,$2)',
        [f, sha(sql)]);
      console.log(`applied  ${f} (${Date.now() - t0}ms)`);
    }
    console.log(`done. ${applied.size + pending.length} migration(s) recorded.`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
