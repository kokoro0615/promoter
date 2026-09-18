#!/usr/bin/env tsx
// seed.ts - development/test fixtures. Runs as postgres (superuser bypasses
// FORCE RLS); this is fixture setup, not a substitute for runtime auth tests.
// Usage: tsx tools/seed.ts
// Writes devdb/seed.json with stable fixture ids for tests and the PWA.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import pg from 'pg';
import { nameKey } from '../src/server/lib/namekey.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const url = process.env.SEED_DATABASE_URL
  || 'postgresql://postgres@127.0.0.1:55432/nightclub_dev';
const DEV_ISSUER = 'dev-local';
const DEV_CLIENT = 'dev';
const PIN = '1234';

const ALL_PERMS = [
  'audit.read', 'credential.manage', 'customer.designate', 'customer.lookup',
  'customer.manage', 'customer.create', 'customer.update', 'customer.check',
  'customer.revoke_regular', 'device.enroll', 'device.manage', 'device.revoke',
  'event.manage', 'event.read', 'floor.manage', 'floor.publish',
  'membership.manage', 'offline.reconcile', 'permit.manage', 'policy.manage',
  'reward.manage', 'role.manage', 'settlement.finalize', 'settlement.manage',
  'sync.ack', 'sync.read', 'sales.read', 'device.unlock',
  'visit.create', 'visit.proxy', 'visit.read',
  'visit.edit', 'visit.update', 'visit.cancel', 'approval.read',
  'approval.decide', 'entrance.match', 'entrance.checkin', 'entrance.checkout',
  'entry.create', 'entry.correct', 'payment.create', 'payment.record',
  'payment.refund', 'booking.create', 'booking.read', 'booking.decide',
  'booking.checkout', 'booking.cancel', 'booking.move', 'booking.manage',
  'booking.approve', 'report.own', 'report.export', 'sales.record',
];
const ROLE_PERMS: Record<string, string[]> = {
  ADMIN: ALL_PERMS,
  ENTRANCE: [
    'entrance.match', 'entrance.checkin', 'entrance.checkout', 'entry.create',
    'entry.correct', 'visit.create', 'visit.read', 'visit.update',
    'customer.lookup', 'customer.create', 'customer.update', 'customer.check',
    'sync.read', 'sync.ack', 'sales.read', 'device.unlock',
    'payment.create', 'payment.record',
    'payment.refund', 'approval.read', 'approval.decide', 'event.read',
    'booking.read', 'booking.checkout', 'report.own', 'sales.record',
  ],
  PROMOTER: [
    'visit.create', 'visit.proxy', 'visit.read', 'visit.edit', 'visit.cancel',
    'customer.lookup', 'customer.create', 'customer.update', 'event.read',
    'report.own', 'booking.create', 'booking.read', 'approval.read',
  ],
  APPROVER: [
    'approval.read', 'approval.decide', 'visit.read', 'customer.lookup',
    'event.read',
  ],
};

async function main() {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    const existing = await c.query('SELECT count(*)::int AS n FROM nightclub.tenants');
    if (existing.rows[0].n > 0) {
      throw new Error('database is not empty; run `pnpm db:reset` first');
    }
    const one = async (sql: string, v: unknown[]) =>
      (await c.query(sql, v)).rows[0].id as string;

    const tenant = await one(
      `INSERT INTO nightclub.tenants (name) VALUES ($1) RETURNING id`,
      ['Dev Tenant']);
    const store = await one(
      `INSERT INTO nightclub.stores (tenant_id, name) VALUES ($1,$2)
        RETURNING id`, [tenant, 'Club Dev']);
    const store2 = await one(
      `INSERT INTO nightclub.stores (tenant_id, name) VALUES ($1,$2)
        RETURNING id`, [tenant, 'Club Other']);
    // Second tenant for cross-tenant negative tests.
    const tenantB = await one(
      `INSERT INTO nightclub.tenants (name) VALUES ($1) RETURNING id`,
      ['Rival Tenant']);
    const storeB = await one(
      `INSERT INTO nightclub.stores (tenant_id, name) VALUES ($1,$2)
        RETURNING id`, [tenantB, 'Club Rival']);

    const mkUser = async (subject: string, name: string) => {
      const u = await one(
        `INSERT INTO nightclub.app_users (display_name) VALUES ($1)
          RETURNING id`, [name]);
      await c.query(
        `INSERT INTO nightclub.external_identities
           (user_id, issuer, client_id, subject) VALUES ($1,$2,$3,$4)`,
        [u, DEV_ISSUER, DEV_CLIENT, subject]);
      return u;
    };
    const mkMember = async (storeId: string, userId: string, name: string) =>
      one(
        `INSERT INTO nightclub.memberships
           (tenant_id, store_id, user_id, display_name, status, valid_from)
         VALUES ($1,$2,$3,$4,'ACTIVE',CURRENT_TIMESTAMP - interval '1 day')
         RETURNING id`, [tenant, storeId, userId, name]);
    const mkRole = async (tenantId: string, storeId: string, key: string, name: string) =>
      one(
        `INSERT INTO nightclub.roles (tenant_id, store_id, role_key, name)
         VALUES ($1,$2,$3,$4) RETURNING id`, [tenantId, storeId, key, name]);
    const grant = async (tenantId: string, storeId: string, roleId: string, perm: string) =>
      c.query(
        `INSERT INTO nightclub.role_permissions
           (tenant_id, store_id, role_id, permission_key)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [tenantId, storeId, roleId, perm]);
    const assign = async (
      tenantId: string, storeId: string, memberId: string, roleId: string, by: string,
    ) => c.query(
      `INSERT INTO nightclub.membership_roles
         (tenant_id, store_id, membership_id, role_id, granted_by)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [tenantId, storeId, memberId, roleId, by]);

    const uAdmin = await mkUser('admin', 'Akira Admin');
    const uPromo = await mkUser('promoter', 'Hanako Promoter');
    const uDoor = await mkUser('door', 'Taro Door');
    const uAppr = await mkUser('approver', 'Mika Approver');
    const uRival = await mkUser('rival', 'Rin Rival');
    const uSaas = await mkUser('saas', 'Seiichi SaaS');
    await c.query(
      `INSERT INTO nightclub.platform_operators (user_id, display_name)
       VALUES ($1,$2)`, [uSaas, 'Seiichi SaaS']);
    const planBasic = await one(
      `INSERT INTO nightclub.plans (code, name, features, limits)
       VALUES ('BASIC','Basic','{}'::jsonb,
               '{"stores":3,"memberships":50}'::jsonb) RETURNING id`, []);
    const planPro = await one(
      `INSERT INTO nightclub.plans (code, name, features, limits)
       VALUES ('PRO','Pro','{"vip":true}'::jsonb,
               '{"stores":20,"memberships":500}'::jsonb) RETURNING id`, []);

    const mAdmin = await mkMember(store, uAdmin, 'Akira (admin)');
    const mPromo = await mkMember(store, uPromo, 'Hanako (promoter)');
    const mDoor = await mkMember(store, uDoor, 'Taro (entrance)');
    const mAppr = await mkMember(store, uAppr, 'Mika (approver)');
    const mRival = await one(
      `INSERT INTO nightclub.memberships
         (tenant_id, store_id, user_id, display_name, status, valid_from)
       VALUES ($1,$2,$3,$4,'ACTIVE',CURRENT_TIMESTAMP - interval '1 day')
       RETURNING id`, [tenantB, storeB, uRival, 'Rin (rival)']);

    const rAdmin = await mkRole(tenant, store, 'ADMIN', 'Administrator');
    const rEntrance = await mkRole(tenant, store, 'ENTRANCE', 'Entrance staff');
    const rPromo = await mkRole(tenant, store, 'PROMOTER', 'Promoter');
    const rAppr = await mkRole(tenant, store, 'APPROVER', 'Designated approver');
    const rRival = await mkRole(tenantB, storeB, 'ADMIN', 'Administrator');
    for (const [role, perms] of Object.entries(ROLE_PERMS)) {
      const rid = { ADMIN: rAdmin, ENTRANCE: rEntrance, PROMOTER: rPromo, APPROVER: rAppr }[role]!;
      for (const p of perms) await grant(tenant, store, rid, p);
    }
    for (const p of ALL_PERMS) await grant(tenantB, storeB, rRival, p);
    await assign(tenant, store, mAdmin, rAdmin, mAdmin);
    await assign(tenant, store, mDoor, rEntrance, mAdmin);
    await assign(tenant, store, mPromo, rPromo, mAdmin);
    await assign(tenant, store, mAppr, rAppr, mAdmin);
    await assign(tenantB, storeB, mRival, rRival, mRival);

    // Operator PINs for shared-device unlock (argon2id).
    const pinHash = await argon2.hash(PIN, { type: argon2.argon2id });
    for (const m of [mDoor, mAdmin]) {
      await c.query(
        `INSERT INTO nightclub.operator_credentials
           (tenant_id, store_id, membership_id, pin_hash)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [tenant, store, m, pinHash]);
    }

    // Event + published policy (policy schema: spec/current/policy.schema.json).
    const now = Date.now();
    const opens = new Date(now - 3600e3).toISOString();
    const closes = new Date(now + 8 * 3600e3).toISOString();
    const event = await one(
      `INSERT INTO nightclub.events
         (tenant_id, store_id, name, opens_at, closes_at, status)
       VALUES ($1,$2,$3,$4,$5,'PUBLISHED') RETURNING id`,
      [tenant, store, 'Dev Night', opens, closes]);
    const settings = {
      schema_version: '4.0.0', environment: 'EXAMPLE_ONLY', event_id: event,
      timezone: 'Asia/Tokyo', currency: 'JPY',
      effective_from: opens, effective_to: closes,
      registration_from: new Date(now - 24 * 3600e3).toISOString(),
      registration_to: closes, apply_mode: 'NEW_ONLY',
      price_rules: [
        { rule_key: 'general', label: 'General', kind: 'NORMAL',
          amount_minor: 300000, entry_from: opens, entry_to: closes,
          payment_required: false, standard_allowed: true },
        { rule_key: 'guest_free', label: 'Guest free', kind: 'FREE',
          amount_minor: 0, entry_from: opens, entry_to: closes,
          payment_required: false, standard_allowed: false },
      ],
      event_free_limit: { mode: 'LIMITED', value: 50 },
      max_party_size: { mode: 'LIMITED', value: 8 },
      approval: {
        designated_member_ids: [mAppr], entrance_regular_approval: true,
        self_approval_allowed: false,
        renotify_after_seconds: 300, escalate_after_seconds: 900,
      },
      default_companion_policy: 'LIMITED_COMPANIONS',
      customer_match_methods: ['KNOWN_BY_STAFF', 'BOOKING_CONTEXT', 'CONTACT_HINT', 'OTHER'],
      limits_unset_block_publish: true,
    };
    const pv = await one(
      `INSERT INTO nightclub.policy_versions
         (tenant_id, store_id, event_id, version, status, settings,
          effective_from, effective_to, apply_mode, published_by,
          published_at)
       VALUES ($1,$2,$3,1,'PUBLISHED',$4,$5,$6,'NEW_ONLY',$7,
          CURRENT_TIMESTAMP) RETURNING id`,
      [tenant, store, event, JSON.stringify(settings), opens, closes, mAdmin]);
    // Materialize price rules + quota buckets (same as publish route).
    for (const r of settings.price_rules) {
      await c.query(
        `INSERT INTO nightclub.price_rules
           (tenant_id, store_id, event_id, policy_version_id, rule_key,
            price_kind, amount_minor, currency, entry_from, entry_to,
            payment_required)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [tenant, store, event, pv, r.rule_key, r.kind, r.amount_minor,
          'JPY', r.entry_from, r.entry_to, r.payment_required]);
    }
    await c.query(
      `INSERT INTO nightclub.quota_buckets
         (tenant_id, store_id, event_id, bucket_key, bucket_kind,
          limit_mode, limit_count)
       VALUES ($1,$2,$3,'event_free','EVENT_HARD','LIMITED',50),
              ($1,$2,$3,'manual','MANUAL_DECIDER','UNLIMITED',NULL)`,
      [tenant, store, event]);

    // Same-day assignments: door staff approve normally; approver is designated.
    for (const [mid, kind] of [
      [mDoor, 'ENTRANCE'], [mDoor, 'ENTRANCE_APPROVER'],
      [mAppr, 'DESIGNATED_APPROVER'], [mPromo, 'REFERRER'],
      [mAdmin, 'ENTRANCE'],
    ] as const) {
      await c.query(
        `INSERT INTO nightclub.event_assignments
           (tenant_id, store_id, event_id, membership_id, assignment_kind,
            starts_at, ends_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [tenant, store, event, mid, kind,
          new Date(now - 24 * 3600e3).toISOString(), closes]);
    }

    // Floor map + tables (2D inventory: layout jsonb holds positions).
    const map = await one(
      `INSERT INTO nightclub.floor_maps
         (tenant_id, store_id, version, layout, status)
       VALUES ($1,$2,1,$3,'PUBLISHED') RETURNING id`,
      [tenant, store, JSON.stringify({
        tables: [
          { table_code: 'A1', x: 40, y: 40, w: 80, h: 80 },
          { table_code: 'A2', x: 200, y: 40, w: 80, h: 80 },
          { table_code: 'VIP1', x: 40, y: 200, w: 140, h: 100 },
        ],
      })]);
    for (const [code, zone, min, max] of [
      ['A1', 'floor', 2, 4], ['A2', 'floor', 4, 6], ['VIP1', 'vip', 4, 8],
    ] as const) {
      await c.query(
        `INSERT INTO nightclub.venue_tables
           (tenant_id, store_id, table_code, zone, capacity_min, capacity_max)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [tenant, store, code, zone, min, max]);
    }

    // Sample customers (incl. same-name pair to prove no auto-merge).
    const cust = async (name: string, regular = false) =>
      one(
        `INSERT INTO nightclub.customers
           (tenant_id, store_id, display_name, name_key, regular_status)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [tenant, store, name, nameKey(name), regular ? 'DESIGNATED' : 'NONE']);
    const cYamada1 = await cust('山田 太郎');
    const cYamada2 = await cust('山田太郎');
    const cSato = await cust('佐藤 花子', true);

    await c.query('COMMIT');
    const out = {
      tenant, store, store2, tenantB, storeB, event, floorMap: map,
      users: { admin: uAdmin, promoter: uPromo, door: uDoor, approver: uAppr, rival: uRival, saas: uSaas },
      plans: { basic: planBasic, pro: planPro },
      members: { admin: mAdmin, promoter: mPromo, door: mDoor, approver: mAppr, rival: mRival },
      customers: { yamada1: cYamada1, yamada2: cYamada2, sato: cSato },
      pin: PIN, devIssuer: DEV_ISSUER,
    };
    mkdirSync(join(ROOT, 'devdb'), { recursive: true });
    writeFileSync(join(ROOT, 'devdb', 'seed.json'), JSON.stringify(out, null, 2));
    console.log('seeded. ids -> devdb/seed.json');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
