// Shared entrance device: enrollment/pairing, operator PIN sessions, lock.
// Device credentials alone never expose guest data (RLS scope='device').
import type { FastifyInstance, FastifyReply } from 'fastify';
import argon2 from 'argon2';
import { config } from '../config.js';
import { withCtx, withSystem } from '../lib/db.js';
import { E } from '../lib/errors.js';
import { hashToken, pairingCode, randomToken, sha256 } from '../lib/crypto.js';
import { audit } from '../lib/tx.js';
import {
  body, params, storeParam, str, uuid as sUuid, version,
} from '../lib/schemas.js';
import {
  requirePersonal, requireDevice, requireOperator, requirePerm, gucPersonal, gucDevice, gucOperator,
} from '../lib/ctx.js';

function setDeviceCookie(reply: FastifyReply, token: string) {
  reply.setCookie(config.cookie.device, token, {
    httpOnly: true, secure: config.cookie.secure, sameSite: 'strict',
    path: config.cookie.path, maxAge: config.ttl.deviceSec,
  });
}
function setOperatorCookie(reply: FastifyReply, token: string) {
  reply.setCookie(config.cookie.operator, token, {
    httpOnly: true, secure: config.cookie.secure, sameSite: 'strict',
    path: config.cookie.path, maxAge: config.ttl.operatorSec,
  });
}

export default async function deviceRoutes(app: FastifyInstance) {
  // Admin issues a one-time pairing code for a new device row.
  app.post('/stores/:storeId/devices/enrollments', {
    schema: {
      params: storeParam,
      body: body({ label: str(60) }, ['label']),
    },
  }, async (req, reply) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'device.enroll');
    const b = req.body as { label?: string };
    if (!b?.label || b.label.length > 60) throw E.invalid('label required');
    const code = pairingCode();
    const expires = new Date(Date.now() + 10 * 60_000); // 10min pairing window
    const out = await withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => {
        const d = await c.query(
          `INSERT INTO nightclub.devices (tenant_id, store_id, label, status, enrolled_by)
           VALUES ($1,$2,$3,'PENDING',$4) RETURNING id`,
          [member.tenantId, storeId, b.label, member.membershipId]);
        const e = await c.query(
          `INSERT INTO nightclub.device_enrollments
             (tenant_id, store_id, device_id, code_hash, issued_by, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [member.tenantId, storeId, d.rows[0].id, sha256(code),
           member.membershipId, expires]);
        await audit(c, {
          scope: 'personal', tenantId: member.tenantId, storeId,
          memberId: member.membershipId, userId: personal.userId,
        }, {
          action: 'device.enroll.create', targetType: 'devices',
          targetId: d.rows[0].id, changes: { label: b.label }, traceId: req.traceId,
        });
        return { deviceId: d.rows[0].id, enrollmentId: e.rows[0].id };
      });
    reply.code(201);
    return {
      enrollment_id: out.enrollmentId, device_id: out.deviceId,
      pairing_code: code, expires_at: expires,
    };
  });

  // Device consumes the pairing code -> device session cookie.
  app.post('/device/enroll', {
    schema: { body: body({ pairing_code: str(100) }, ['pairing_code']) },
  }, async (req, reply) => {
    const b = req.body as { pairing_code?: string };
    if (!b?.pairing_code || b.pairing_code.length < 6 || b.pairing_code.length > 100) {
      throw E.invalid('pairing_code required');
    }
    const token = randomToken();
    const expires = new Date(Date.now() + config.ttl.deviceSec * 1000);
    let r;
    try {
      r = await withSystem(async (c) => {
        const res = await c.query(
          'SELECT * FROM nightclub.device_consume_enrollment($1,$2,$3)',
          [sha256(b.pairing_code!), hashToken(token), expires]);
        return res.rows[0];
      });
    } catch (e) {
      const m = (e as Error).message;
      if (m.includes('ENROLL_USED')) throw E.invalid('code already used');
      if (m.includes('ENROLL_EXPIRED')) throw E.invalid('code expired');
      if (m.includes('DEVICE_REVOKED')) throw E.deviceRevoked();
      throw E.invalid('invalid pairing code');
    }
    setDeviceCookie(reply, token);
    return {
      device_id: r.device_id, store_id: r.store_id,
      expires_at: expires,
    };
  });

  app.get('/stores/:storeId/devices', { schema: { params: storeParam } }, async (req) => {
    const { storeId } = req.params as { storeId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'device.manage');
    return withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => {
        const r = await c.query(
          `SELECT d.id, d.version, d.label, d.status, d.operator_epoch,
                  d.created_at,
                  (SELECT m.display_name FROM nightclub.operator_sessions o
                     JOIN nightclub.memberships m
                       ON m.tenant_id=o.tenant_id AND m.store_id=o.store_id
                      AND m.id=o.membership_id
                    WHERE o.tenant_id=d.tenant_id AND o.store_id=d.store_id
                      AND o.device_id=d.id AND o.ended_at IS NULL
                      AND o.locked_at IS NULL
                    ORDER BY o.created_at DESC LIMIT 1) AS current_operator,
                  (SELECT max(ds.last_seen_at) FROM nightclub.device_sessions ds
                    WHERE ds.tenant_id=d.tenant_id AND ds.store_id=d.store_id
                      AND ds.device_id=d.id) AS last_seen_at
             FROM nightclub.devices d
            WHERE d.tenant_id=$1 AND d.store_id=$2 ORDER BY d.created_at`,
          [member.tenantId, storeId]);
        return { items: r.rows };
      });
  });

  app.post('/stores/:storeId/devices/:deviceId/revoke', {
    schema: {
      params: params({ storeId: sUuid, deviceId: sUuid }),
      body: body({ expected_version: version }),
    },
  }, async (req) => {
    const { storeId, deviceId } = req.params as { storeId: string; deviceId: string };
    const { member, personal } = await requirePersonal(req, storeId);
    requirePerm(member, 'device.revoke');
    const b = (req.body ?? {}) as { expected_version?: number };
    return withCtx(
      gucPersonal(personal.userId, member.tenantId, storeId, member.membershipId),
      async (c) => {
        const r = await c.query(
          `UPDATE nightclub.devices SET status='REVOKED', revoked_at=CURRENT_TIMESTAMP,
              operator_epoch=operator_epoch+1,
              version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status<>'REVOKED'
              AND version=$4 RETURNING version`,
          [member.tenantId, storeId, deviceId, b.expected_version ?? -1]);
        if (!r.rows[0]) throw E.versionConflict();
        await c.query(
          `UPDATE nightclub.device_sessions SET revoked_at=CURRENT_TIMESTAMP,
              version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND device_id=$3 AND revoked_at IS NULL`,
          [member.tenantId, storeId, deviceId]);
        await c.query(
          `UPDATE nightclub.operator_sessions SET ended_at=CURRENT_TIMESTAMP,
              version=version+1, updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=$1 AND store_id=$2 AND device_id=$3 AND ended_at IS NULL`,
          [member.tenantId, storeId, deviceId]);
        await audit(c, {
          scope: 'personal', tenantId: member.tenantId, storeId,
          memberId: member.membershipId, userId: personal.userId,
        }, {
          action: 'device.revoke', targetType: 'devices', targetId: deviceId,
          traceId: req.traceId,
        });
        return { resource_id: deviceId, version: r.rows[0].version, status: 'REVOKED', trace_id: req.traceId };
      });
  });

  // Operator picker: memberships holding device.unlock in this store.
  app.get('/device/operators', async (req) => {
    const d = await requireDevice(req);
    return withCtx(gucDevice(d), async (c) => {
      const r = await c.query(
        `SELECT membership_id, display_name
           FROM nightclub.device_operator_candidates()`,
        []);
      const cur = await c.query(
        `SELECT o.id AS operator_session_id, o.event_id, m.display_name
           FROM nightclub.operator_sessions o
           JOIN nightclub.memberships m
             ON m.tenant_id=o.tenant_id AND m.store_id=o.store_id AND m.id=o.membership_id
          WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.device_id=$3
            AND o.ended_at IS NULL AND o.locked_at IS NULL
          ORDER BY o.created_at DESC LIMIT 1`,
        [d.tenantId, d.storeId, d.deviceId]);
      const ev = await c.query(
        `SELECT id, name, opens_at, closes_at, status FROM nightclub.events
          WHERE tenant_id=$1 AND store_id=$2 AND status IN ('PUBLISHED','OPEN')
          ORDER BY opens_at DESC LIMIT 10`, [d.tenantId, d.storeId]);
      return {
        items: r.rows,
        current_operator: cur.rows[0] ?? null,
        events: ev.rows,
        device_id: d.deviceId,
        store_id: d.storeId,
      };
    });
  });

  // PIN unlock -> operator session. Replacement bumps the device epoch so the
  // previous operator's tabs fail with OPERATOR_CHANGED.
  app.post('/device/operator-sessions', {
    schema: {
      body: body({
        membership_id: sUuid, event_id: sUuid,
        pin: { type: 'string', pattern: '^[0-9]{4,12}$' },
      }, ['membership_id', 'event_id', 'pin']),
    },
  }, async (req, reply) => {
    const d = await requireDevice(req);
    const b = req.body as { membership_id?: string; event_id?: string; pin?: string };
    if (!b?.membership_id || !b.event_id || !b.pin) {
      throw E.invalid('membership_id, event_id and pin required');
    }
    const cred = await withCtx(gucDevice(d, b.event_id), async (c) => {
      const r = await c.query(
        'SELECT * FROM nightclub.operator_credential_get($1)', [b.membership_id]);
      return r.rows[0];
    });
    if (!cred) throw E.unauthenticated('unknown operator');
    if (cred.locked_until && new Date(cred.locked_until) > new Date()) {
      throw E.rateLimited();
    }
    const ok = await argon2.verify(cred.pin_hash, b.pin).catch(() => false);
    await withCtx(gucDevice(d, b.event_id), (c) =>
      c.query('SELECT nightclub.operator_credential_update($1,$2,$3,$4)',
        [b.membership_id, ok, config.pin.maxAttempts, config.pin.lockSec]));
    if (!ok) throw E.unauthenticated('invalid pin');

    const token = randomToken();
    const expires = new Date(Date.now() + config.ttl.operatorSec * 1000);
    const out = await withCtx(gucDevice(d, b.event_id), async (c) => {
      // Assignment + capability gate for entrance work.
      const chk = await c.query(
        `SELECT EXISTS (
           SELECT 1 FROM nightclub.event_assignments ea
            WHERE ea.tenant_id=$1 AND ea.store_id=$2 AND ea.event_id=$3
              AND ea.membership_id=$4
              AND ea.assignment_kind IN ('ENTRANCE','ENTRANCE_APPROVER','DESIGNATED_APPROVER')
              AND ea.starts_at <= CURRENT_TIMESTAMP AND ea.ends_at > CURRENT_TIMESTAMP
         ) AS assigned,
         EXISTS (
           SELECT 1 FROM nightclub.membership_roles mr
           JOIN nightclub.role_permissions rp
             ON rp.tenant_id=mr.tenant_id AND rp.store_id=mr.store_id
            AND rp.role_id=mr.role_id
           WHERE mr.tenant_id=$1 AND mr.store_id=$2 AND mr.membership_id=$4
             AND rp.permission_key='device.unlock'
             AND (mr.expires_at IS NULL OR mr.expires_at > CURRENT_TIMESTAMP)
         ) AS can_unlock`,
        [d.tenantId, d.storeId, b.event_id, b.membership_id]);
      if (!chk.rows[0].can_unlock) throw E.forbidden('device.unlock required');
      if (!chk.rows[0].assigned) throw E.forbidden('not assigned to this event');
      // Serialize operator replacement on the device row.
      const dv = await c.query(
        `UPDATE nightclub.devices SET operator_epoch=operator_epoch+1,
            version=version+1, updated_at=CURRENT_TIMESTAMP
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='ACTIVE'
          RETURNING operator_epoch`,
        [d.tenantId, d.storeId, d.deviceId]);
      if (!dv.rows[0]) throw E.deviceRevoked();
      const epoch = dv.rows[0].operator_epoch as number;
      // End any previous active operator session on this device.
      await c.query(
        `UPDATE nightclub.operator_sessions SET ended_at=CURRENT_TIMESTAMP,
            version=version+1, updated_at=CURRENT_TIMESTAMP
          WHERE tenant_id=$1 AND store_id=$2 AND device_id=$3
            AND ended_at IS NULL`,
        [d.tenantId, d.storeId, d.deviceId]);
      const ins = await c.query(
        `INSERT INTO nightclub.operator_sessions
           (tenant_id, store_id, event_id, device_id, device_session_id,
            membership_id, operator_epoch, token_hash, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [d.tenantId, d.storeId, b.event_id, d.deviceId, d.sessionId,
         b.membership_id, epoch, hashToken(token), expires]);
      return { id: ins.rows[0].id as string, epoch };
    });
    setOperatorCookie(reply, token);
    const perms = await withCtx(gucDevice(d, b.event_id), async (c) => {
      const m = await c.query(
        `SELECT user_id, display_name FROM nightclub.memberships
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
        [d.tenantId, d.storeId, b.membership_id]);
      const p = await c.query(
        `SELECT DISTINCT rp.permission_key FROM nightclub.membership_roles mr
           JOIN nightclub.role_permissions rp
             ON rp.tenant_id=mr.tenant_id AND rp.store_id=mr.store_id
            AND rp.role_id=mr.role_id
          WHERE mr.tenant_id=$1 AND mr.store_id=$2 AND mr.membership_id=$3
            AND (mr.expires_at IS NULL OR mr.expires_at > CURRENT_TIMESTAMP)`,
        [d.tenantId, d.storeId, b.membership_id]);
      return { u: m.rows[0], perms: p.rows.map((x) => x.permission_key) };
    });
    return {
      operator_session_id: out.id,
      operator_epoch: out.epoch,
      actor: {
        user_id: perms.u.user_id, membership_id: b.membership_id,
        store_id: d.storeId, display_name: perms.u.display_name,
        permissions: perms.perms, mode: 'ENTRANCE',
        operator_session_id: out.id, device_id: d.deviceId,
        event_id: b.event_id,
      },
      expires_at: expires,
    };
  });

  // Lock (screen lock): operator session parked; PIN needed to resume.
  app.post('/device/lock', async (req, reply) => {
    const { operator } = await requireOperator(req);
    await withCtx(gucOperator(operator), async (c) => {
      await c.query(
        `UPDATE nightclub.operator_sessions SET locked_at=CURRENT_TIMESTAMP,
            version=version+1, updated_at=CURRENT_TIMESTAMP
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND locked_at IS NULL`,
        [operator.tenantId, operator.storeId, operator.sessionId]);
      await audit(c, gucOperator(operator), {
        action: 'operator.lock', targetType: 'operator_sessions',
        targetId: operator.sessionId, traceId: req.traceId,
      });
    });
    reply.clearCookie(config.cookie.operator, { path: config.cookie.path });
    return { accepted: true, trace_id: req.traceId };
  });

  // Operator session end (handover / sign out of the shared device).
  app.post('/device/operator-sessions/end', async (req, reply) => {
    const { operator } = await requireOperator(req);
    await withCtx(gucOperator(operator), async (c) => {
      await c.query(
        `UPDATE nightclub.operator_sessions SET ended_at=CURRENT_TIMESTAMP,
            version=version+1, updated_at=CURRENT_TIMESTAMP
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND ended_at IS NULL`,
        [operator.tenantId, operator.storeId, operator.sessionId]);
      await c.query(
        `UPDATE nightclub.devices SET operator_epoch=operator_epoch+1,
            version=version+1, updated_at=CURRENT_TIMESTAMP
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
        [operator.tenantId, operator.storeId, operator.deviceId]);
      await audit(c, gucOperator(operator), {
        action: 'operator.end', targetType: 'operator_sessions',
        targetId: operator.sessionId, traceId: req.traceId,
      });
    });
    reply.clearCookie(config.cookie.operator, { path: config.cookie.path });
    return { accepted: true, trace_id: req.traceId };
  });
}
