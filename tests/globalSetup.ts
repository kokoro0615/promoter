// Global test setup: fresh migrated+seeded nightclub_test database.
// Requires the embedded devdb server (tools/devdb.mjs).
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const TEST_URL = 'postgresql://postgres@127.0.0.1:55432/nightclub_test';
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');

export default async function setup() {
  execFileSync('node', [resolve(ROOT, 'tools/devdb.mjs'), 'start'], { stdio: 'inherit' });
  execFileSync(TSX, [resolve(ROOT, 'tools/migrate.ts'), '--reset'], {
    stdio: 'inherit', env: { ...process.env, DATABASE_URL: TEST_URL },
  });
  execFileSync(TSX, [resolve(ROOT, 'tools/seed.ts')], {
    stdio: 'inherit', env: { ...process.env, SEED_DATABASE_URL: TEST_URL },
  });
}
