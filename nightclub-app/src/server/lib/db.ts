// node-postgres pool + transaction helpers.
// All access goes through withCtx()/withSystem() which open a transaction and
// pin the session GUCs used by RLS. GUC values come from verified sessions only.
import pg from 'pg';
import { config } from '../config.js';
import { E } from './errors.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 30,
  idleTimeoutMillis: 30_000,
});

export type Client = pg.PoolClient;

export interface Guc {
  scope: 'anonymous' | 'personal' | 'device' | 'operator' | 'system';
  tenantId?: string | null;
  storeId?: string | null;
  userId?: string | null;
  memberId?: string | null;
  deviceId?: string | null;
  deviceSessionId?: string | null;
  operatorSessionId?: string | null;
  eventId?: string | null;
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization / deadlock

async function setGuc(c: Client, g: Guc) {
  await c.query(
    `SELECT
       set_config('app.scope',$1,true), set_config('app.tenant_id',$2,true),
       set_config('app.store_id',$3,true), set_config('app.user_id',$4,true),
       set_config('app.member_id',$5,true), set_config('app.device_id',$6,true),
       set_config('app.device_session_id',$7,true),
       set_config('app.operator_session_id',$8,true), set_config('app.event_id',$9,true)`,
    [
      g.scope, g.tenantId ?? '', g.storeId ?? '', g.userId ?? '',
      g.memberId ?? '', g.deviceId ?? '', g.deviceSessionId ?? '',
      g.operatorSessionId ?? '', g.eventId ?? '',
    ],
  );
}

export interface TxOpts {
  isolation?: 'REPEATABLE READ' | 'SERIALIZABLE';
  retries?: number;
}

export async function withCtx<T>(
  g: Guc,
  fn: (c: Client) => Promise<T>,
  opts: TxOpts = {},
): Promise<T> {
  const attempts = (opts.retries ?? 3) + 1;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    const c = await pool.connect();
    try {
      await c.query(
        `BEGIN ${opts.isolation ? `ISOLATION LEVEL ${opts.isolation}` : ''}`,
      );
      await setGuc(c, g);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      last = e;
      const st = (e as { code?: string }).code;
      if (!RETRYABLE.has(st ?? '') || i === attempts - 1) {
        if (st === '40001' || st === '40P01') throw E.unavailable();
        throw e;
      }
    } finally {
      c.release();
    }
  }
  throw last;
}

// System scope: worker/maintenance paths. Never reachable from request ctx.
// Optional GUC fields (e.g. userId) let RLS bootstrap clauses like
// "user_id = ctx_user()" apply to a verified subject.
export const withSystem = <T>(
  fn: (c: Client) => Promise<T>, opts?: TxOpts,
  guc?: Partial<Omit<Guc, 'scope'>>,
) => withCtx<T>({ scope: 'system', ...guc }, fn, opts);
