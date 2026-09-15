// Request context resolution: cookies -> verified sessions -> GUC context.
// Cookies are opaque tokens; only their sha256 hashes reach the DB (via the
// SECURITY DEFINER bridges). GUCs are populated from verified rows only.
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { withSystem, type Client, type Guc } from './db.js';
import { E } from './errors.js';
import { hashToken } from './crypto.js';

export interface PersonalCtx {
  sessionId: string; userId: string; expiresAt: Date;
}
export interface DeviceCtx {
  sessionId: string; deviceId: string; tenantId: string; storeId: string;
  operatorEpoch: string; expiresAt: Date;
}
export interface OperatorCtx {
  sessionId: string; tenantId: string; storeId: string; eventId: string;
  deviceId: string; deviceSessionId: string; membershipId: string;
  epoch: string; userId: string; displayName: string; expiresAt: Date;
}
export interface MemberCtx {
  membershipId: string; userId: string; tenantId: string; storeId: string;
  displayName: string; permissions: Set<string>;
}

export class ReqAuth {
  private _personal?: Promise<PersonalCtx | null>;
  private _device?: Promise<DeviceCtx | null>;
  private _operator?: Promise<OperatorCtx | null>;
  constructor(private req: FastifyRequest) {}

  private cookie(name: string) {
    return this.req.cookies[name];
  }

  personal(): Promise<PersonalCtx | null> {
    return (this._personal ??= (async () => {
      const tok = this.cookie(config.cookie.personal);
      if (!tok) return null;
      return withSystem(async (c) => {
        const r = await c.query(
          'SELECT * FROM nightclub.auth_resolve_session($1)', [hashToken(tok)]);
        const s = r.rows[0];
        if (!s || s.revoked_at || s.user_status !== 'ACTIVE') return null;
        if (new Date(s.expires_at) <= new Date()) return null;
        return { sessionId: s.session_id, userId: s.user_id, expiresAt: s.expires_at };
      });
    })());
  }

  device(): Promise<DeviceCtx | null> {
    return (this._device ??= (async () => {
      const tok = this.cookie(config.cookie.device);
      if (!tok) return null;
      return withSystem(async (c) => {
        const r = await c.query(
          'SELECT * FROM nightclub.device_resolve_session($1)', [hashToken(tok)]);
        const s = r.rows[0];
        if (!s || s.revoked_at) return null;
        if (s.device_status !== 'ACTIVE') throw E.deviceRevoked();
        if (new Date(s.expires_at) <= new Date()) return null;
        return {
          sessionId: s.session_id, deviceId: s.device_id,
          tenantId: s.tenant_id, storeId: s.store_id,
          operatorEpoch: String(s.operator_epoch), expiresAt: s.expires_at,
        };
      });
    })());
  }

  operator(): Promise<OperatorCtx | null> {
    return (this._operator ??= (async () => {
      const tok = this.cookie(config.cookie.operator);
      if (!tok) return null;
      return withSystem(async (c) => {
        const r = await c.query(
          'SELECT * FROM nightclub.operator_resolve_session($1)', [hashToken(tok)]);
        const s = r.rows[0];
        if (!s) return null;
        if (s.device_status !== 'ACTIVE') throw E.deviceRevoked();
        // Operator replacement bumps device.operator_epoch; a stale tab's
        // session no longer matches -> 409 OPERATOR_CHANGED (never reassigned).
        if (String(s.device_epoch) !== String(s.operator_epoch)) {
          throw E.operatorChanged();
        }
        if (s.ended_at || s.locked_at) return null;
        if (new Date(s.expires_at) <= new Date()) return null;
        if (s.member_status !== 'ACTIVE') throw E.forbidden('membership inactive');
        return {
          sessionId: s.session_id, tenantId: s.tenant_id, storeId: s.store_id,
          eventId: s.event_id, deviceId: s.device_id,
          deviceSessionId: s.device_session_id, membershipId: s.membership_id,
          epoch: String(s.operator_epoch), userId: s.member_user_id,
          displayName: s.member_display_name, expiresAt: s.expires_at,
        };
      });
    })());
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: ReqAuth;
    traceId: string;
  }
}

export function gucPersonal(userId: string, tenant?: string, store?: string, member?: string): Guc {
  return {
    scope: 'personal', userId,
    tenantId: tenant ?? null, storeId: store ?? null, memberId: member ?? null,
  };
}
export function gucDevice(d: DeviceCtx, eventId?: string): Guc {
  return {
    scope: 'device', tenantId: d.tenantId, storeId: d.storeId,
    deviceId: d.deviceId, deviceSessionId: d.sessionId, eventId: eventId ?? null,
  };
}
export function gucOperator(o: OperatorCtx): Guc {
  return {
    scope: 'operator', tenantId: o.tenantId, storeId: o.storeId,
    deviceId: o.deviceId, deviceSessionId: o.deviceSessionId,
    operatorSessionId: o.sessionId, eventId: o.eventId,
    memberId: o.membershipId, userId: o.userId,
  };
}

// Load the caller's active membership in a store + its permission set.
export async function memberInStore(
  c: Client, userId: string, tenantId: string, storeId: string,
): Promise<MemberCtx | null> {
  const m = await c.query(
    `SELECT id, display_name, status, valid_from, valid_to
       FROM nightclub.memberships
      WHERE tenant_id=$1 AND store_id=$2 AND user_id=$3`,
    [tenantId, storeId, userId]);
  const row = m.rows[0];
  if (!row || row.status !== 'ACTIVE') return null;
  if (row.valid_to && new Date(row.valid_to) <= new Date()) return null;
  if (new Date(row.valid_from) > new Date()) return null;
  const p = await c.query(
    `SELECT DISTINCT rp.permission_key
       FROM nightclub.membership_roles mr
       JOIN nightclub.role_permissions rp
         ON rp.tenant_id=mr.tenant_id AND rp.store_id=mr.store_id
        AND rp.role_id=mr.role_id
      WHERE mr.tenant_id=$1 AND mr.store_id=$2 AND mr.membership_id=$3
        AND (mr.expires_at IS NULL OR mr.expires_at > CURRENT_TIMESTAMP)`,
    [tenantId, storeId, row.id]);
  return {
    membershipId: row.id, userId, tenantId, storeId,
    displayName: row.display_name,
    permissions: new Set(p.rows.map((r) => r.permission_key)),
  };
}

export function requirePerm(m: MemberCtx, perm: string) {
  if (!m.permissions.has(perm)) throw E.forbidden(`missing ${perm}`);
}

// Personal-auth route helper: resolve session + membership in :storeId.
export async function requirePersonal(req: FastifyRequest, storeId: string) {
  const p = await req.auth.personal();
  if (!p) throw E.unauthenticated();
  // membership lookup crosses tenant boundary deliberately: memberships rows
  // are visible to their own user (bootstrap policy).
  const tenantId = await withSystem(async (c) => {
    const s = await c.query(
      'SELECT tenant_id FROM nightclub.stores WHERE id=$1', [storeId]);
    if (!s.rows[0]) throw E.notFound('store');
    return s.rows[0].tenant_id as string;
  });
  const member = await withSystem(
    (c) => memberInStore(c, p.userId, tenantId, storeId),
    undefined, { userId: p.userId, tenantId, storeId });
  if (!member) throw E.forbidden('not a member of this store');
  return { personal: p, member };
}

export async function requireOperator(req: FastifyRequest) {
  const o = await req.auth.operator();
  if (!o) {
    const d = await req.auth.device();
    if (d) throw E.operatorRequired();
    throw E.unauthenticated();
  }
  const hdr = req.headers['x-operator-context'];
  if (hdr !== o.sessionId) throw E.operatorChanged();
  const member = await withSystem((c) =>
    memberInStore(c, o.userId, o.tenantId, o.storeId),
    undefined, { userId: o.userId, tenantId: o.tenantId, storeId: o.storeId });
  if (!member || member.membershipId !== o.membershipId) {
    throw E.forbidden('membership inactive');
  }
  return { operator: o, member };
}

export async function requireDevice(req: FastifyRequest) {
  const d = await req.auth.device();
  if (!d) throw E.unauthenticated('device pairing required');
  return d;
}

export async function eventAssignments(
  c: Client, m: MemberCtx, eventId: string,
): Promise<Set<string>> {
  const r = await c.query(
    `SELECT assignment_kind FROM nightclub.event_assignments
      WHERE tenant_id=$1 AND store_id=$2 AND event_id=$3 AND membership_id=$4
        AND starts_at <= CURRENT_TIMESTAMP AND ends_at > CURRENT_TIMESTAMP`,
    [m.tenantId, m.storeId, eventId, m.membershipId]);
  return new Set(r.rows.map((x) => x.assignment_kind));
}
