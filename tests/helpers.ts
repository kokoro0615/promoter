import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/server/app.js';
import type { FastifyInstance } from 'fastify';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
export const seed = () =>
  JSON.parse(readFileSync(join(ROOT, 'devdb/seed.json'), 'utf8')) as {
    tenant: string; store: string; store2: string; tenantB: string;
    storeB: string; event: string; floorMap: string; pin: string;
    users: Record<string, string>; members: Record<string, string>;
    customers: Record<string, string>;
  };

let app: FastifyInstance | null = null;
export async function getApp() {
  return (app ??= await buildApp());
}

export type Cookies = Record<string, string>;
export function mergeCookies(res: { cookies: { name: string; value: string }[] }, into: Cookies = {}) {
  for (const ck of res.cookies) if (ck.value) into[ck.name] = ck.value;
  return into;
}
export function cookieHeader(c: Cookies) {
  return Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ');
}

export async function devLogin(subject: string, name?: string): Promise<Cookies> {
  const a = await getApp();
  const res = await a.inject({
    method: 'POST', url: '/api/auth/dev/login',
    payload: { subject, display_name: name },
  });
  if (res.statusCode !== 200) throw new Error(`login ${subject}: ${res.body}`);
  return mergeCookies(res);
}

export interface CallOpts {
  cookies?: Cookies; operatorSession?: string; idem?: string;
}
export async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string, opts: CallOpts = {}, body?: unknown,
) {
  const a = await getApp();
  const headers: Record<string, string> = {};
  if (opts.cookies) headers.cookie = cookieHeader(opts.cookies);
  if (opts.operatorSession) headers['x-operator-context'] = opts.operatorSession;
  if (opts.idem) headers['idempotency-key'] = opts.idem;
  const res = await a.inject({ method, url: `/api${url}`, headers, payload: body as never });
  let json: unknown = null;
  try { json = res.json(); } catch { /* empty */ }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, body: json as any, res };
}
