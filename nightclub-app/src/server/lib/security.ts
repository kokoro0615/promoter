// Request-hardening hooks: baseline security headers, same-site enforcement
// for cookie-authenticated mutations (CSRF via Fetch Metadata + Origin),
// and a per-instance token-bucket rate limiter for credential-ish endpoints.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { E } from './errors.js';

// F-021: API is JSON-only; deny embedding/sniffing entirely.
const SEC_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};

// Paths that are legitimately called cross-origin/server-to-server or by
// non-browser clients and must skip the browser-origin guard.
const GUARD_EXEMPT = [
  /^\/api\/integrations\/[^/]+\/webhooks$/, // signed provider callbacks
];

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function sameOrigin(req: FastifyRequest): boolean {
  // Fetch Metadata (modern browsers): allow same-origin/same-site and 'none'
  // (typed URL, curl — no ambient cookies attached cross-site anyway).
  const fss = req.headers['sec-fetch-site'];
  if (typeof fss === 'string') {
    return ['same-origin', 'same-site', 'none'].includes(fss.toLowerCase());
  }
  // Fallback: Origin header must match the Host we're serving on.
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') {
    try {
      const host = req.headers.host;
      return !!host && new URL(origin).host === host;
    } catch { return false; }
  }
  // No browser metadata at all: non-browser client (curl, server-to-server).
  return true;
}

// ---- rate limiter (F-009) ----
// Token bucket keyed by bucket-name + client IP. In-memory: correct for the
// single-instance deployment topology; multi-instance needs a shared store
// (Redis) — recorded as a scaling decision, not silently absent.
interface Bucket { tokens: number; ts: number }
const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

export function rateLimit(name: string, limit: number, windowMs: number) {
  return (key: string) => {
    const now = Date.now();
    if (now - lastSweep > 60_000) {
      lastSweep = now;
      for (const [k, v] of buckets) {
        if (now - v.ts > windowMs * 4) buckets.delete(k);
      }
    }
    const id = `${name}:${key}`;
    const b = buckets.get(id) ?? { tokens: limit, ts: now };
    const refill = ((now - b.ts) / windowMs) * limit;
    b.tokens = Math.min(limit, b.tokens + refill);
    b.ts = now;
    if (b.tokens < 1) { buckets.set(id, b); return false; }
    b.tokens -= 1;
    buckets.set(id, b);
    return true;
  };
}

// Sensitive endpoint budgets. Keyed on client IP (request may pre-date auth).
const limiters = [
  { re: /^\/api\/auth\//, name: 'auth', limit: 20, windowMs: 60_000 },
  { re: /^\/api\/device\/(enroll|operator-sessions)/, name: 'device', limit: 20, windowMs: 60_000 },
  { re: /^\/api\/invitations\//, name: 'invite', limit: 20, windowMs: 60_000 },
  { re: /\/tickets\/redeem$/, name: 'redeem', limit: 30, windowMs: 60_000 },
  { re: /^\/api\/public\//, name: 'public', limit: 30, windowMs: 60_000 },
  { re: /\/customers(\?|$)/, name: 'custsearch', limit: 60, windowMs: 60_000 },
  { re: /^\/api\/integrations\/[^/]+\/webhooks$/, name: 'webhook', limit: 120, windowMs: 60_000 },
];

export function registerSecurity(app: FastifyInstance) {
  app.addHook('onSend', async (req, reply) => {
    for (const [k, v] of Object.entries(SEC_HEADERS)) reply.header(k, v);
  });

  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0]!;
    for (const l of limiters) {
      if (l.re.test(req.url)) {
        if (!rateLimit(l.name, l.limit, l.windowMs)(req.ip)) {
          throw E.rateLimited();
        }
        break;
      }
    }
    if (STATE_CHANGING.has(req.method) && !GUARD_EXEMPT.some((re) => re.test(path))) {
      if (!sameOrigin(req)) throw E.crossOriginForbidden();
    }
  });
}
