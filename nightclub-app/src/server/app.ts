import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import { AppError } from './lib/errors.js';
import { ReqAuth } from './lib/ctx.js';
import { registerSecurity } from './lib/security.js';
import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import eventRoutes from './routes/events.js';
import customerRoutes from './routes/customers.js';
import visitRoutes from './routes/visits.js';
import syncRoutes from './routes/sync.js';
import financeRoutes from './routes/finance.js';
import vipRoutes from './routes/vip.js';
import opsRoutes from './routes/ops.js';
import platformRoutes, { storeSettingsRoutes } from './routes/platform.js';
import ticketRoutes from './routes/tickets.js';
import posRoutes from './routes/pos.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, genReqId: () => randomUUID() });
  await app.register(cookie);
  registerSecurity(app);

  app.addHook('onRequest', async (req) => {
    req.auth = new ReqAuth(req);
    req.traceId = req.id as string;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      reply.code(err.status).type('application/problem+json').send({
        type: `urn:nc:${err.code}`, title: err.code, status: err.status,
        code: err.code, detail: err.message, trace_id: req.traceId,
        current_version: err.opts.currentVersion ?? null,
        retryable: err.opts.retryable ?? false,
        field_errors: err.opts.fieldErrors ?? undefined,
      });
      return;
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    reply.code(status).type('application/problem+json').send({
      type: 'urn:nc:INTERNAL', title: status >= 500 ? 'INTERNAL' : 'BAD_REQUEST',
      status, code: status >= 500 ? 'INTERNAL' : 'VALIDATION',
      detail: status >= 500 ? 'internal error'
        : (err instanceof Error ? err.message : 'bad request'),
      trace_id: req.traceId, retryable: false,
    });
    if (status >= 500) console.error(err);
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).type('application/problem+json').send({
      type: 'urn:nc:NOT_FOUND', title: 'NOT_FOUND', status: 404,
      code: 'NOT_FOUND', detail: 'route not found', trace_id: req.traceId,
      retryable: false,
    });
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api/healthz', async () => ({ ok: true }));

  await app.register(async (api) => {
    await api.register(authRoutes);
    await api.register(deviceRoutes);
    await api.register(eventRoutes);
    await api.register(customerRoutes);
    await api.register(visitRoutes);
    await api.register(syncRoutes);
    await api.register(financeRoutes);
    await api.register(vipRoutes);
    await api.register(opsRoutes);
    await api.register(platformRoutes);
    await api.register(storeSettingsRoutes);
    await api.register(ticketRoutes);
    await api.register(posRoutes);
  }, { prefix: '/api' });

  return app;
}
