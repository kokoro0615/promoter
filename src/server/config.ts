// Server configuration. Secrets come from the environment; .env is dev-only.
const env = process.env;
const int = (v: string | undefined, d: number) => (v ? parseInt(v, 10) : d);

export const config = {
  env: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  host: env.HOST || '127.0.0.1',
  port: int(env.PORT, 8787),
  databaseUrl:
    env.DATABASE_URL ||
    'postgresql://app_runtime:dev_runtime@127.0.0.1:55432/nightclub_dev',
  // Dev issuer: explicit opt-in and forbidden in production.
  devAuth: env.DEV_AUTH === '1' && env.NODE_ENV !== 'production',
  oidc: {
    issuer: env.OIDC_ISSUER || '',
    clientId: env.OIDC_CLIENT_ID || '',
  },
  snapshotSecret: env.SNAPSHOT_SECRET || 'dev-snapshot-secret',
  cookie: {
    personal: '__Host-nc_personal',
    device: '__Host-nc_device',
    operator: '__Host-nc_operator',
    secure: true, // __Host- requires Secure; localhost is a secure context
    path: '/',
  },
  ttl: {
    personalSec: int(env.SESSION_TTL_PERSONAL_SEC, 60 * 60 * 24 * 14),
    deviceSec: int(env.SESSION_TTL_DEVICE_SEC, 60 * 60 * 24 * 30),
    operatorSec: int(env.SESSION_TTL_OPERATOR_SEC, 60 * 60 * 12),
    receiptSec: int(env.RECEIPT_TTL_SEC, 60 * 60 * 24),
    snapshotSec: int(env.SNAPSHOT_TTL_SEC, 600),
  },
  pin: {
    maxAttempts: int(env.PIN_MAX_ATTEMPTS, 5),
    lockSec: int(env.PIN_LOCK_SEC, 300),
  },
  changes: {
    pageLimit: 500,
    pollMs: int(env.CHANGES_POLL_MS, 1500),
  },
};

if (config.isProd && config.snapshotSecret === 'dev-snapshot-secret') {
  throw new Error('SNAPSHOT_SECRET must be set in production');
}
