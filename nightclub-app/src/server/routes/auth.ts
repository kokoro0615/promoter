// Auth + membership administration routes.
import type { FastifyInstance, FastifyReply } from 'fastify';
import argon2 from 'argon2';
import { config } from '../config.js';
import { withCtx, withSystem } from '../lib/db.js';
import { E } from '../lib/errors.js';
import { hashToken, randomToken, sha256 } from '../lib/crypto.js';
import { otpauthUrl, totpSecret, totpVerify } from '../lib/totp.js';
import { audit } from '../lib/tx.js';
import {
  body, params, query, storeParam, str, uuid as sUuid, version,
} from '../lib/schemas.js';
import {
  requirePersonal, requirePerm, gucPersonal,
} from '../lib/ctx.js';

const DEV_ISSUER = 'dev-local';
const DEV_CLIENT = 'dev';

function setPersonalCookie(reply: FastifyReply, token: string, maxAgeSec: number) {
  reply.setCookie(config.cookie.personal, token, {
    httpOnly: true, secure: config.cookie.secure, sameSite: 'lax',
    path: config.cookie.path, maxAge: maxAgeSec,
  });
}

async function createPersonalSession(userId: string) {
  const token = randomToken();
  const expires = new Date(Date.now() + config.ttl.personalSec * 1000);
  const sessionId = await withSystem(async (c) => {
    const r = await c.query(
      'SELECT nightclub.auth_create_session($1,$2,$3) AS id',
      [userId, hashToken(token), expires]);
    return r.rows[0].id as string;
  });
  return { token, sessionId, expires };
}

export async function membershipList(userId: string) {
  return withSystem(async (c) => {
    // system scope + userId: memberships bootstrap clause
    // (user_id = ctx_user()) exposes this user's rows across stores.
    const r = await c.query(
      `SELECT m.id AS membership_id, m.tenant_id, m.store_id, m.display_name,
              m.status, s.name AS store_name, t.name AS tenant_name,
              (SELECT array_agg(DISTINCT rp.permission_key)
                 FROM nightclub.membership_roles mr
                 JOIN nightclub.role_permissions rp
                   ON rp.tenant_id=mr.tenant_id AND rp.store_id=mr.store_id
                  AND rp.role_id=mr.role_id
                WHERE mr.tenant_id=m.tenant_id AND mr.store_id=m.store_id
                  AND mr.membership_id=m.id
                  AND (mr.expires_at IS NULL OR mr.expires_at > CURRENT_TIMESTAMP)
              ) AS permissions
         FROM nightclub.memberships m
         JOIN nightclub.stores s ON s.tenant_id=m.tenant_id AND s.id=m.store_id
         JOIN nightclub.tenants t ON t.id=m.tenant_id
        WHERE m.user_id=$1 AND m.status IN ('INVITED','ACTIVE','SUSPENDED')
        ORDER BY s.name`, [userId]);
    return r.rows;
  }, undefined, { userId });
}

export default async function authRoutes(app: FastifyInstance) {
  // --- dev issuer (isolated development only; disabled in production) ---
  app.post('/auth/dev/login', {
    schema: {
      body: body({ subject: str(80), display_name: str(200) }, ['subject']),
    },
  }, async (req, reply) => {
    if (!config.devAuth) throw E.notFound();
    const b = (req.body ?? {}) as { subject?: string; display_name?: string };
    if (!b.subject || !/^[\w.@-]{1,80}$/.test(b.subject)) {
      throw E.invalid('subject required');
    }
    const found = await withSystem(async (c) => {
      const r = await c.query(
        'SELECT * FROM nightclub.auth_find_identity($1,$2,$3)',
        [DEV_ISSUER, DEV_CLIENT, b.subject]);
      return r.rows[0];
    });
    let userId = found?.user_id as string | undefined;
    if (found && found.user_status !== 'ACTIVE') throw E.forbidden('user suspended');
    if (!userId) {
      if (!b.display_name) throw E.invalid('display_name required for new user');
      userId = await withSystem(async (c) => {
        const r = await c.query(
          'SELECT nightclub.auth_create_user($1,$2,$3,$4) AS id',
          [b.display_name, DEV_ISSUER, DEV_CLIENT, b.subject]);
        return r.rows[0].id as string;
      });
    }
    const s = await createPersonalSession(userId);
    setPersonalCookie(reply, s.token, config.ttl.personalSec);
    return { user_id: userId, memberships: await membershipList(userId) };
  });

  // Real OIDC start: provider contract is defined, connection is gated.
  app.get('/auth/line/start', async () => {
    throw E.unavailable();
  });

  app.post('/auth/logout', async (req, reply) => {
    const p = await req.auth.personal();
    if (p) {
      await withSystem((c) =>
        c.query('SELECT nightclub.auth_revoke_session($1)', [p.sessionId]));
    }
    reply.clearCookie(config.cookie.personal, { path: config.cookie.path });
    return { accepted: true, trace_id: req.traceId };
  });

  app.get('/me', async (req) => {
    const p = await req.auth.personal();
    if (!p) throw E.unauthenticated();
    const memberships = await membershipList(p.userId);
    const u = await withSystem((c) =>
      c.query('SELECT display_name FROM nightclub.app_users WHERE id=$1', [p.userId]));
    return {
      user_id: p.userId,
      display_name: u.rows[0]?.display_name ?? null,
      memberships,
    };
  });

  // --- invitations ---
  app.get('/invitations/:token/lookup', {
    schema: { params: params({ token: str(200) }) },
  }, async (req) => {
    const { token } = req.params as { token: string };
    const r = await withSystem((c) =>
      c.query('SELECT * FROM nightclub.invitation_lookup($1)', [sha256(token)]));
    const row = r.rows[0];
    if (!row) throw E.notFound('invitation');
    return {
      store_name: row.store_name, role_name: row.role_name,
      invite_target: row.invite_target, expires_at: row.expires_at,
      usable: !row.used_at && new Date(row.expires_at) > new Date(),
    };
  });

  app.post('/invitations/accept', {
    schema: {
      body: body({
        token: str(200), display_name: str(200), dev_subject: str(80),
      }, ['token', 'display_name']),
    },
  }, async (req, reply) => {
    const b = req.body as {
      token?: string; display_name?: string; dev_subject?: string;
    };
    if (!b?.token || !b.display_name) throw E.invalid('token and display_name required');
    // Dev mode: the "OIDC subject" is chosen explicitly. Production: subject
    // comes from the verified OIDC id_token (adapter, gated).
    const subject = b.dev_subject;
    if (!config.devAuth || !subject || !/^[\w.@-]{1,80}$/.test(subject)) {
      throw E.invalid('dev_subject required (dev issuer)');
    }
    let out;
    try {
      out = await withSystem(async (c) => {
        const r = await c.query(
          'SELECT * FROM nightclub.invitation_redeem($1,$2,$3,$4,$5)',
          [sha256(b.token!), b.display_name, DEV_ISSUER, DEV_CLIENT, subject]);
        return r.rows[0];
      });
    } catch (e) {
      const m = (e as Error).message;
      if (m.includes('INVITE_USED')) throw E.invalid('invitation already used');
      if (m.includes('INVITE_EXPIRED')) throw E.invalid('invitation expired');
      if (m.includes('INVITE_INVALID')) throw E.notFound('invitation');
      throw e;
    }
    const s = await createPersonalSession(out.user_id);
    setPersonalCookie(reply, s.token, config.ttl.personalSec);
    return {
      user_id: out.user_id, membership_id: out.membership_id,
      store_id: out.store_id, memberships: await membershipList(out.user_id),
    };
  });

  app.post('/stores/:storeId/invitations', {
    schema: {
      params: storeParam,
      body: body({
        invite_target: str(64), role_key: str(64),
        expires_hours: { type: 'integer', minimum: 1, maximum: 8760 },
      }),
    },
  }, async (req) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'membership.manage');
    const b = req.body as {
      invite_target?: string; role_key?: string; expires_hours?: number;
    };
    const token = randomToken(24);
    const expires = new Date(Date.now() + (b?.expires_hours ?? 72) * 3600_000);
    const row = await withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => {
        let roleId: string | null = null;
        if (b?.role_key) {
          const rr = await c.query(
            `SELECT id FROM nightclub.roles
              WHERE tenant_id=$1 AND store_id=$2 AND role_key=$3`,
            [member.tenantId, storeId, b.role_key]);
          if (!rr.rows[0]) throw E.invalid('unknown role_key');
          roleId = rr.rows[0].id;
        }
        const ins = await c.query(
          `INSERT INTO nightclub.invitation_tokens
             (tenant_id, store_id, token_hash, invite_target, role_id, issued_by, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [member.tenantId, storeId, sha256(token),
           b?.invite_target ?? 'STAFF', roleId, member.membershipId, expires]);
        await audit(c, {
          scope: 'personal', tenantId: member.tenantId, storeId,
          memberId: member.membershipId, userId: personal.userId,
        }, {
          action: 'invitation.create', targetType: 'invitation_tokens',
          targetId: ins.rows[0].id, changes: { role_key: b?.role_key ?? null },
          traceId: req.traceId,
        });
        return ins.rows[0];
      });
    return { invitation_id: row.id, token, expires_at: expires };
  });

  // --- memberships / roles administration ---
  app.get('/stores/:storeId/memberships', { schema: { params: storeParam } }, async (req) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'membership.manage');
    return withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => {
        const r = await c.query(
          `SELECT m.id, m.user_id, m.display_name, m.status,
                  m.valid_from, m.valid_to, m.version,
                  (SELECT array_agg(r.role_key) FROM nightclub.membership_roles mr
                     JOIN nightclub.roles r
                       ON r.tenant_id=mr.tenant_id AND r.store_id=mr.store_id
                      AND r.id=mr.role_id
                    WHERE mr.tenant_id=m.tenant_id AND mr.store_id=m.store_id
                      AND mr.membership_id=m.id) AS role_keys,
                  EXISTS (SELECT 1 FROM nightclub.operator_credentials oc
                     WHERE oc.tenant_id=m.tenant_id AND oc.store_id=m.store_id
                       AND oc.membership_id=m.id) AS has_pin
             FROM nightclub.memberships m
            WHERE m.tenant_id=$1 AND m.store_id=$2
            ORDER BY m.created_at`,
          [member.tenantId, storeId]);
        return { items: r.rows };
      });
  });

  app.post('/stores/:storeId/memberships/:membershipId/suspend', {
    schema: {
      params: params({ storeId: sUuid, membershipId: sUuid }),
      body: body({ expected_version: version, reason: str(1000) }),
    },
  }, async (req) => {
    const { storeId, membershipId } = req.params as { storeId: string; membershipId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'membership.manage');
    const b = (req.body ?? {}) as { expected_version?: number; reason?: string };
    return withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => {
        const r = await c.query(
          `UPDATE nightclub.memberships SET status='SUSPENDED',
              version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='ACTIVE'
              AND version=$4
            RETURNING version`,
          [member.tenantId, storeId, membershipId, b.expected_version ?? -1]);
        if (!r.rows[0]) throw E.versionConflict();
        await audit(c, {
          scope: 'personal', tenantId: member.tenantId, storeId,
          memberId: member.membershipId, userId: personal.userId,
        }, {
          action: 'membership.suspend', targetType: 'memberships',
          targetId: membershipId, reason: b.reason ?? null, traceId: req.traceId,
        });
        return { resource_id: membershipId, version: r.rows[0].version, status: 'SUSPENDED', trace_id: req.traceId };
      });
  });

  app.put('/stores/:storeId/memberships/:membershipId/operator-pin', {
    schema: {
      params: params({ storeId: sUuid, membershipId: sUuid }),
      body: body({ pin: { type: 'string', pattern: '^[0-9]{4,12}$' } }, ['pin']),
    },
  }, async (req) => {
    const { storeId, membershipId } = req.params as { storeId: string; membershipId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'credential.manage');
    const b = req.body as { pin?: string };
    if (!b?.pin || !/^[0-9]{4,12}$/.test(b.pin)) {
      throw E.invalid('pin must be 4-12 digits');
    }
    const pinHash = await argon2.hash(b.pin, { type: argon2.argon2id });
    return withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => {
        const chk = await c.query(
          `SELECT id FROM nightclub.memberships
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='ACTIVE'`,
          [member.tenantId, storeId, membershipId]);
        if (!chk.rows[0]) throw E.notFound('membership');
        await c.query(
          `INSERT INTO nightclub.operator_credentials
             (tenant_id, store_id, membership_id, pin_hash)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (tenant_id, store_id, membership_id)
           DO UPDATE SET pin_hash=EXCLUDED.pin_hash, failed_attempts=0,
             locked_until=NULL,
             credential_version=operator_credentials.credential_version+1,
             version=operator_credentials.version+1, updated_at=CURRENT_TIMESTAMP`,
          [member.tenantId, storeId, membershipId, pinHash]);
        await audit(c, {
          scope: 'personal', tenantId: member.tenantId, storeId,
          memberId: member.membershipId, userId: personal.userId,
        }, {
          action: 'operator_pin.set', targetType: 'memberships',
          targetId: membershipId, traceId: req.traceId,
        });
        return { accepted: true, trace_id: req.traceId };
      });
  });

  // F-011: list roles with their permission keys (role.manage or
  // membership.manage — inviters need the catalog to pick a role).
  app.get('/stores/:storeId/roles', { schema: { params: storeParam } }, async (req) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    if (!member.permissions.has('role.manage')
        && !member.permissions.has('membership.manage')) {
      throw E.forbidden('role.manage or membership.manage required');
    }
    return withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => {
        const r = await c.query(
          `SELECT r.id, r.role_key, r.name, r.version,
                  COALESCE((SELECT array_agg(rp.permission_key ORDER BY rp.permission_key)
                     FROM nightclub.role_permissions rp
                    WHERE rp.tenant_id=r.tenant_id AND rp.store_id=r.store_id
                      AND rp.role_id=r.id), '{}') AS permissions
             FROM nightclub.roles r
            WHERE r.tenant_id=$1 AND r.store_id=$2
            ORDER BY r.role_key`,
          [member.tenantId, storeId]);
        return { items: r.rows };
      });
  });

  // F-012: (re)assign the role set of a membership. Full replacement in one
  // transaction; expires_at untouched (time-boxed grants keep their expiry).
  app.put('/stores/:storeId/memberships/:membershipId/roles', {
    schema: {
      params: params({ storeId: sUuid, membershipId: sUuid }),
      body: body({
        role_ids: { type: 'array', items: sUuid, maxItems: 50 },
        expected_version: version,
      }, ['role_ids']),
    },
  }, async (req) => {
    const { storeId, membershipId } = req.params as { storeId: string; membershipId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'membership.manage');
    const b = req.body as { role_ids?: string[]; expected_version?: number };
    return withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => {
        const m = await c.query(
          `UPDATE nightclub.memberships SET version=version+1,
              updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND version=$4
            RETURNING version`,
          [member.tenantId, storeId, membershipId, b.expected_version ?? -1]);
        if (!m.rows[0]) throw E.versionConflict();
        const roles = await c.query(
          `SELECT id FROM nightclub.roles
            WHERE tenant_id=$1 AND store_id=$2 AND id = ANY($3::uuid[])`,
          [member.tenantId, storeId, b.role_ids ?? []]);
        if (roles.rows.length !== new Set(b.role_ids).size) {
          throw E.invalid('unknown role_id in role_ids');
        }
        await c.query(
          `DELETE FROM nightclub.membership_roles
            WHERE tenant_id=$1 AND store_id=$2 AND membership_id=$3`,
          [member.tenantId, storeId, membershipId]);
        for (const rid of new Set(b.role_ids)) {
          await c.query(
            `INSERT INTO nightclub.membership_roles
               (tenant_id, store_id, membership_id, role_id, granted_by)
             VALUES ($1,$2,$3,$4,$5)`,
            [member.tenantId, storeId, membershipId, rid, member.membershipId]);
        }
        await audit(c, {
          scope: 'personal', tenantId: member.tenantId, storeId,
          memberId: member.membershipId, userId: personal.userId,
        }, {
          action: 'membership.roles.set', targetType: 'memberships',
          targetId: membershipId,
          changes: { role_ids: b.role_ids }, traceId: req.traceId,
        });
        return {
          resource_id: membershipId, version: m.rows[0].version,
          status: 'UPDATED', trace_id: req.traceId,
        };
      });
  });

  // F-013: member-facing notification inbox (IN_APP jobs for the caller)
  // + read acknowledgement via notification_reads (idempotent).
  app.get('/stores/:storeId/me/notifications', {
    schema: {
      params: storeParam,
      querystring: query({
        unread_only: { type: 'string', enum: ['true', 'false'] },
        limit: { type: 'string', pattern: '^[0-9]+$', maxLength: 4 },
      }),
    },
  }, async (req) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    const q = req.query as { unread_only?: string; limit?: string };
    const limit = Math.min(Number(q.limit) || 50, 200);
    return withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => {
        const r = await c.query(
          `SELECT j.id, j.event_id, j.channel, j.status, j.scheduled_at,
                  j.payload, j.created_at, nr.read_at
             FROM nightclub.notification_jobs j
             LEFT JOIN nightclub.notification_reads nr
               ON nr.tenant_id=j.tenant_id AND nr.store_id=j.store_id
              AND nr.notification_job_id=j.id AND nr.membership_id=$4
            WHERE j.tenant_id=$1 AND j.store_id=$2
              AND j.recipient_membership_id=$4 AND j.channel='IN_APP'
              AND j.status IN ('QUEUED','SENT')
              AND ($3::boolean IS FALSE OR nr.read_at IS NULL)
            ORDER BY j.created_at DESC LIMIT $5`,
          [member.tenantId, storeId, q.unread_only === 'true',
           member.membershipId, limit]);
        return { items: r.rows };
      });
  });

  app.post('/stores/:storeId/me/notifications/:notificationId/read', {
    schema: {
      params: params({ storeId: sUuid, notificationId: sUuid }),
    },
  }, async (req) => {
    const { storeId, notificationId } = req.params as { storeId: string; notificationId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    return withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => {
        const j = await c.query(
          `SELECT id FROM nightclub.notification_jobs
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3
              AND recipient_membership_id=$4 AND channel='IN_APP'`,
          [member.tenantId, storeId, notificationId, member.membershipId]);
        if (!j.rows[0]) throw E.notFound('notification');
        await c.query(
          `INSERT INTO nightclub.notification_reads
             (tenant_id, store_id, notification_job_id, membership_id)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [member.tenantId, storeId, notificationId, member.membershipId]);
        return { read: true, trace_id: req.traceId };
      });
  });

  app.put('/stores/:storeId/roles/:roleId', {
    schema: {
      params: params({ storeId: sUuid, roleId: sUuid }),
      body: body({
        permissions: { type: 'array', items: str(100), maxItems: 200 },
        expected_version: version,
      }, ['permissions']),
    },
  }, async (req) => {
    const { storeId, roleId } = req.params as { storeId: string; roleId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'role.manage');
    const b = req.body as { permissions?: string[]; expected_version?: number };
    if (!Array.isArray(b?.permissions)) throw E.invalid('permissions required');
    return withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => {
        const r = await c.query(
          `UPDATE nightclub.roles SET version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND version=$4
            RETURNING version`,
          [member.tenantId, storeId, roleId, b.expected_version ?? -1]);
        if (!r.rows[0]) throw E.versionConflict();
        await c.query(
          `DELETE FROM nightclub.role_permissions
            WHERE tenant_id=$1 AND store_id=$2 AND role_id=$3`,
          [member.tenantId, storeId, roleId]);
        for (const p of b.permissions!) {
          await c.query(
            `INSERT INTO nightclub.role_permissions
               (tenant_id, store_id, role_id, permission_key)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT DO NOTHING`,
            [member.tenantId, storeId, roleId, p]);
        }
        await audit(c, {
          scope: 'personal', tenantId: member.tenantId, storeId,
          memberId: member.membershipId, userId: personal.userId,
        }, {
          action: 'role.update', targetType: 'roles', targetId: roleId,
          changes: { permissions: b.permissions }, traceId: req.traceId,
        });
        return { resource_id: roleId, version: r.rows[0].version, status: 'UPDATED', trace_id: req.traceId };
      });
  });

  // ---- email-link login (LINE Login alternative, R&D decision) --------------
  // Delivery of the actual email is an external-integration blocker (no mail
  // provider contract). Tokens are issued server-side; in DEV_AUTH mode the
  // token is returned in the response so the flow is exercisable end-to-end.
  app.post('/auth/email-link/request', {
    schema: {
      body: body({ email: { type: 'string', format: 'email', maxLength: 320 } },
        ['email']),
    },
  }, async (req, reply) => {
    reply.code(202);
    const b = req.body as { email?: string };
    const email = (b?.email ?? '').trim().toLowerCase();
    if (!email || !email.includes('@')) throw E.invalid('email required');
    const found = await withSystem(async (c) => {
      const r = await c.query(
        'SELECT * FROM nightclub.user_by_email_identity($1)', [email]);
      return r.rows[0];
    });
    // Always 202: the response must not reveal whether the address is bound.
    if (!found || found.status !== 'ACTIVE') {
      return { accepted: true, trace_id: req.traceId };
    }
    const token = randomToken();
    const expires = new Date(Date.now() + config.emailLinkTtlSec * 1000);
    await withSystem((c) =>
      c.query('SELECT nightclub.email_link_issue($1,$2,$3,$4)',
        [email, sha256(token), found.user_id, expires]));
    return {
      accepted: true, trace_id: req.traceId,
      ...(config.devAuth ? { dev_token: token, expires_at: expires } : {}),
    };
  });

  app.post('/auth/email-link/redeem', {
    schema: { body: body({ token: str(200) }, ['token']) },
  }, async (req, reply) => {
    const b = req.body as { token?: string };
    if (!b?.token) throw E.invalid('token required');
    const r = await withSystem(async (c) => {
      const res = await c.query(
        'SELECT * FROM nightclub.email_link_redeem($1)', [sha256(b.token!)]);
      return res.rows[0] as
        { user_id: string | null; email: string; already_used: boolean }
        | undefined;
    });
    if (!r) throw E.invalid('invalid or expired token');
    if (r.already_used) throw E.invalid('token already used');
    if (!r.user_id) throw E.invalid('invalid or expired token');
    const s = await createPersonalSession(r.user_id);
    setPersonalCookie(reply, s.token, config.ttl.personalSec);
    return {
      user_id: r.user_id, memberships: await membershipList(r.user_id),
    };
  });

  // Bind an email identity to the signed-in user (verified via link token).
  app.post('/me/email-identity/bind', {
    schema: {
      body: body({ email: { type: 'string', format: 'email', maxLength: 320 } },
        ['email']),
    },
  }, async (req, reply) => {
    reply.code(202);
    const p = await req.auth.personal();
    if (!p) throw E.unauthenticated();
    const b = req.body as { email?: string };
    const email = (b?.email ?? '').trim().toLowerCase();
    if (!email || !email.includes('@')) throw E.invalid('email required');
    const existing = await withSystem(async (c) => {
      const r = await c.query(
        'SELECT * FROM nightclub.user_by_email_identity($1)', [email]);
      return r.rows[0];
    });
    if (existing && existing.user_id !== p.userId) {
      throw E.conflict('email already bound to another account');
    }
    const token = randomToken();
    const expires = new Date(Date.now() + config.emailLinkTtlSec * 1000);
    await withSystem((c) =>
      c.query('SELECT nightclub.email_link_issue($1,$2,$3,$4)',
        [email, sha256(token), p.userId, expires]));
    return {
      accepted: true, trace_id: req.traceId,
      ...(config.devAuth ? { dev_token: token, expires_at: expires } : {}),
    };
  });

  app.post('/me/email-identity/confirm', {
    schema: { body: body({ token: str(200) }, ['token']) },
  }, async (req) => {
    const p = await req.auth.personal();
    if (!p) throw E.unauthenticated();
    const b = req.body as { token?: string };
    if (!b?.token) throw E.invalid('token required');
    const r = await withSystem(async (c) => {
      const tok = await c.query(
        'SELECT * FROM nightclub.email_link_redeem($1)', [sha256(b.token!)]);
      const row = tok.rows[0] as
        { user_id: string | null; email: string; already_used: boolean }
        | undefined;
      if (!row || row.already_used || !row.user_id) {
        throw E.invalid('invalid or expired token');
      }
      if (row.user_id !== p.userId) {
        throw E.forbidden('token issued for a different account');
      }
      return row.email;
    });
    await withSystem((c) =>
      c.query('SELECT nightclub.email_identity_bind($1,$2)', [p.userId, r]));
    return { bound: r, trace_id: req.traceId };
  });

  // ---- TOTP MFA + recovery codes + session step-up ---------------------------
  app.get('/me/mfa', async (req) => {
    const p = await req.auth.personal();
    if (!p) throw E.unauthenticated();
    const rows = await withSystem(async (c) =>
      (await c.query('SELECT * FROM nightclub.mfa_state()', [])).rows,
      undefined, { userId: p.userId });
    return {
      credentials: rows,
      stepped_up: !!p.stepUpAt
        && Date.now() - p.stepUpAt.getTime() < config.stepUpSec * 1000,
    };
  });

  app.post('/me/mfa/totp/begin', async (req) => {
    const p = await req.auth.personal();
    if (!p) throw E.unauthenticated();
    const secret = totpSecret();
    await withSystem((c) =>
      c.query('SELECT nightclub.mfa_totp_begin($1)', [secret]),
      undefined, { userId: p.userId });
    const me = await withSystem((c) =>
      c.query('SELECT display_name FROM nightclub.app_users WHERE id=$1',
        [p.userId]));
    return {
      secret,
      otpauth_url: otpauthUrl(secret, me.rows[0]?.display_name ?? p.userId),
      trace_id: req.traceId,
    };
  });

  app.post('/me/mfa/totp/activate', {
    schema: { body: body({ code: { type: 'string', pattern: '^[0-9]{6}$' } },
      ['code']) },
  }, async (req) => {
    const p = await req.auth.personal();
    if (!p) throw E.unauthenticated();
    const b = req.body as { code?: string };
    const sec = await withSystem(async (c) =>
      (await c.query('SELECT * FROM nightclub.mfa_totp_secret()', [])).rows[0],
      undefined, { userId: p.userId });
    if (!sec || sec.status !== 'PENDING') {
      throw E.invalid('no pending TOTP enrollment');
    }
    if (!b?.code || !totpVerify(sec.secret, b.code)) {
      throw E.invalid('invalid code');
    }
    const codes = Array.from({ length: 10 }, () => randomToken(9));
    await withSystem(async (c) => {
      await c.query('SELECT nightclub.mfa_totp_activate()', []);
      await c.query('SELECT nightclub.mfa_recovery_replace($1)',
        [codes.map((x) => sha256(x))]);
      await c.query('SELECT nightclub.auth_mark_step_up($1)', [p.sessionId]);
    }, undefined, { userId: p.userId });
    return { activated: true, recovery_codes: codes, trace_id: req.traceId };
  });

  // Verify a second factor: TOTP code, or single-use recovery code.
  async function verifySecondFactor(
    userId: string, code: string | undefined, recovery: string | undefined,
  ): Promise<'totp' | 'recovery'> {
    const sec = await withSystem(async (c) =>
      (await c.query('SELECT * FROM nightclub.mfa_totp_secret()', [])).rows[0],
      undefined, { userId });
    if (!sec || sec.status !== 'ACTIVE') {
      throw E.invalid('TOTP not enrolled');
    }
    if (code && totpVerify(sec.secret, code)) return 'totp';
    if (recovery) {
      const ok = await withSystem(async (c) => {
        const r = await c.query(
          'SELECT nightclub.mfa_recovery_consume($1) AS ok',
          [sha256(recovery)]);
        return r.rows[0]?.ok === true;
      }, undefined, { userId });
      if (ok) return 'recovery';
    }
    throw E.invalid('invalid second factor');
  }

  app.post('/me/mfa/step-up', {
    schema: {
      body: body({
        code: { type: 'string', pattern: '^[0-9]{6}$' },
        recovery_code: str(64),
      }),
    },
  }, async (req) => {
    const p = await req.auth.personal();
    if (!p) throw E.unauthenticated();
    const b = req.body as { code?: string; recovery_code?: string };
    if (!b?.code && !b?.recovery_code) throw E.invalid('code required');
    await verifySecondFactor(p.userId, b.code, b.recovery_code);
    await withSystem((c) =>
      c.query('SELECT nightclub.auth_mark_step_up($1)', [p.sessionId]),
      undefined, { userId: p.userId });
    return { stepped_up: true, trace_id: req.traceId };
  });

  app.post('/me/mfa/recovery/regenerate', {
    schema: {
      body: body({ code: { type: 'string', pattern: '^[0-9]{6}$' } }, ['code']),
    },
  }, async (req) => {
    const p = await req.auth.personal();
    if (!p) throw E.unauthenticated();
    const b = req.body as { code?: string };
    await verifySecondFactor(p.userId, b.code, undefined);
    const codes = Array.from({ length: 10 }, () => randomToken(9));
    await withSystem((c) =>
      c.query('SELECT nightclub.mfa_recovery_replace($1)',
        [codes.map((x) => sha256(x))]),
      undefined, { userId: p.userId });
    return { recovery_codes: codes, trace_id: req.traceId };
  });

  app.post('/me/mfa/totp/disable', {
    schema: {
      body: body({
        code: { type: 'string', pattern: '^[0-9]{6}$' },
        recovery_code: str(64),
      }),
    },
  }, async (req) => {
    const p = await req.auth.personal();
    if (!p) throw E.unauthenticated();
    const b = req.body as { code?: string; recovery_code?: string };
    if (!b?.code && !b?.recovery_code) throw E.invalid('code required');
    await verifySecondFactor(p.userId, b.code, b.recovery_code);
    await withSystem((c) =>
      c.query('SELECT nightclub.mfa_totp_disable()', []),
      undefined, { userId: p.userId });
    return { disabled: true, trace_id: req.traceId };
  });
}
