// RLS/role verification using the REAL runtime roles (app_runtime /
// app_readonly), not superuser. Context GUCs are set the same way the API does.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const seed = () => JSON.parse(readFileSync(join(ROOT, 'devdb/seed.json'), 'utf8'));
const RUNTIME = process.env.RUNTIME_DATABASE_URL!;
const READONLY = process.env.READONLY_DATABASE_URL!;

async function scoped<T>(
  url: string, guc: Record<string, string>, fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const [k, v] of Object.entries(guc)) {
      await c.query(`SELECT set_config($1, $2, true)`, [`app.${k}`, v]);
    }
    const out = await fn(c);
    await c.query('ROLLBACK');
    return out;
  } finally {
    await c.end();
  }
}

const personal = (s: ReturnType<typeof seed>, store: string, member: string) => ({
  scope: 'personal', tenant_id: s.tenant, store_id: store,
  user_id: s.users.admin, member_id: member,
});
const operator = (s: ReturnType<typeof seed>, member: string) => ({
  scope: 'operator', tenant_id: s.tenant, store_id: s.store,
  event_id: s.event, member_id: member, device_id: s.devices?.main ?? '',
  device_session_id: '', operator_session_id: '', user_id: s.users.door,
});

describe('RLS with app_runtime', () => {
  let s: ReturnType<typeof seed>;
  beforeAll(() => { s = seed(); });

  it('personal scope sees only own store customers', async () => {
    const rows = await scoped(RUNTIME, personal(s, s.store, s.members.admin), (c) =>
      c.query('SELECT id FROM nightclub.customers'));
    expect(rows.rows.length).toBeGreaterThanOrEqual(3);
    const cross = await scoped(RUNTIME, personal(s, s.store, s.members.admin), (c) =>
      c.query('SELECT id FROM nightclub.customers WHERE id = ANY($1::uuid[])',
        [[s.customers.yamada1]]));
    expect(cross.rows.length).toBe(1);
  });

  it('personal scope cannot see other tenant customers', async () => {
    // admin of tenant A, scoped to tenant B's store -> zero rows
    const rows = await scoped(RUNTIME, {
      scope: 'personal', tenant_id: s.tenantB, store_id: s.storeB,
      user_id: s.users.admin, member_id: s.members.admin,
    }, (c) => c.query('SELECT count(*)::int n FROM nightclub.customers'));
    expect(rows.rows[0].n).toBe(0);
  });

  it('no context -> no rows (deny by default)', async () => {
    const rows = await scoped(RUNTIME, { scope: '' }, (c) =>
      c.query('SELECT count(*)::int n FROM nightclub.customers'));
    expect(rows.rows[0].n).toBe(0);
  });

  it('device scope cannot list customers (device auth != data auth)', async () => {
    const rows = await scoped(RUNTIME, {
      scope: 'device', tenant_id: s.tenant, store_id: s.store,
      device_id: 'x', device_session_id: 'x',
    }, (c) => c.query('SELECT count(*)::int n FROM nightclub.customers'));
    expect(rows.rows[0].n).toBe(0);
  });

  it('app_runtime cannot UPDATE/DELETE immutable tables', async () => {
    await expect(scoped(RUNTIME, personal(s, s.store, s.members.admin), (c) =>
      c.query(`UPDATE nightclub.audit_logs SET action='x'`)))
      .rejects.toThrow(/permission denied/);
    await expect(scoped(RUNTIME, personal(s, s.store, s.members.admin), (c) =>
      c.query(`DELETE FROM nightclub.outbox_events`)))
      .rejects.toThrow(/permission denied/);
  });

  it('app_readonly can read scoped data but not write', async () => {
    const rows = await scoped(READONLY, personal(s, s.store, s.members.admin), (c) =>
      c.query('SELECT count(*)::int n FROM nightclub.customers'));
    expect(rows.rows[0].n).toBeGreaterThanOrEqual(3);
    await expect(scoped(READONLY, personal(s, s.store, s.members.admin), (c) =>
      c.query(`INSERT INTO nightclub.customers
        (tenant_id, store_id, display_name, name_key)
        VALUES ($1,$2,'x','x')`, [s.tenant, s.store])))
      .rejects.toThrow(/permission denied/);
  });

  it('app_readonly cannot execute definer bridge functions', async () => {
    await expect(scoped(READONLY, {}, (c) =>
      c.query(`SELECT * FROM nightclub.auth_find_identity('a','b','c')`)))
      .rejects.toThrow(/permission denied/);
  });
});
