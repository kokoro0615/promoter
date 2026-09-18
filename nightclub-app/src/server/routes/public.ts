// Public (unauthenticated) booking form endpoints.
//
// The booking_pages table is store-scoped RLS; the only public read path is
// the slug-bound SECURITY DEFINER lookup. Submissions are written through
// the normal bookings table under the tenant/store GUCs resolved from the
// page — the same two-phase pattern as provider webhooks. Contact details
// land in bookings.contact (explicitly "never identity"); every submission
// is APPROVAL_PENDING until staff decide it. No payment ever moves through
// an unauthenticated endpoint.
import type { FastifyInstance } from 'fastify';
import { withSystem } from '../lib/db.js';
import { E } from '../lib/errors.js';
import { audit, emit } from '../lib/tx.js';
import { body, int, isoTs, params, str } from '../lib/schemas.js';

interface PageRow {
  tenant_id: string; store_id: string; event_id: string;
  title: string; message: string | null; collect_phone: boolean;
  max_party: number; event_name: string; event_starts_at: string;
  store_name: string; currency: string;
}

async function lookupPage(slug: string): Promise<PageRow> {
  const r = await withSystem(async (c) =>
    (await c.query(
      'SELECT * FROM nightclub.booking_page_lookup($1)', [slug])).rows[0]);
  if (!r) throw E.notFound('booking page');
  return r as PageRow;
}

export default async function publicRoutes(app: FastifyInstance) {
  // Render data for the public form. Safe fields only — no internal ids
  // beyond what the URL already proves knowledge of.
  app.get('/public/booking-pages/:slug', {
    schema: { params: params({ slug: str(64) }) },
  }, async (req) => {
    const { slug } = req.params as { slug: string };
    const p = await lookupPage(slug);
    return {
      title: p.title, message: p.message,
      collect_phone: p.collect_phone, max_party: p.max_party,
      store_name: p.store_name, event_name: p.event_name,
      event_starts_at: p.event_starts_at, currency: p.currency,
    };
  });

  // Submit a booking request. Always lands as APPROVAL_PENDING — a public
  // post is a request, never a confirmed allocation.
  app.post('/public/booking-pages/:slug/submissions', {
    schema: {
      params: params({ slug: str(64) }),
      body: body({
        name: str(200), phone: str(40), note: str(1000),
        party_count: { type: 'integer', minimum: 1 },
        starts_at: isoTs, ends_at: isoTs,
      }, ['name', 'party_count', 'starts_at']),
    },
  }, async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const b = req.body as {
      name?: string; phone?: string; note?: string;
      party_count?: number; starts_at?: string; ends_at?: string;
    };
    const p = await lookupPage(slug);
    if (!b?.name || !b.party_count || !b.starts_at) {
      throw E.invalid('name, party_count, starts_at required');
    }
    if (b.party_count > p.max_party) throw E.invalid('party_count exceeds maximum');
    if (p.collect_phone && !b.phone) throw E.invalid('phone required');
    const start = new Date(b.starts_at);
    if (Number.isNaN(start.getTime())) throw E.invalid('starts_at invalid');
    // Default slot length: 2h (staff adjust on decision/move).
    const end = b.ends_at ? new Date(b.ends_at)
      : new Date(start.getTime() + 2 * 3600_000);
    if (end <= start) throw E.invalid('ends_at must be after starts_at');

    const g = {
      scope: 'system' as const, tenantId: p.tenant_id, storeId: p.store_id,
    };
    const out = await withSystem(async (c) => {
      const ins = await c.query(
        `INSERT INTO nightclub.bookings
           (tenant_id, store_id, event_id, visit_id, customer_id, party_count,
            starts_at, ends_at, status, admission_pricing,
            minimum_minor, deposit_minor, currency, policy_snapshot, contact)
         VALUES ($1,$2,$3,NULL,NULL,$4,$5,$6,'APPROVAL_PENDING','SEPARATE',
                 0,0,$7,'{}'::jsonb,$8) RETURNING id`,
        [p.tenant_id, p.store_id, p.event_id, b.party_count,
         start.toISOString(), end.toISOString(), p.currency,
         JSON.stringify({
           name: b.name, phone: b.phone ?? null, note: b.note ?? null,
           source: 'public_page', slug,
         })]);
      const bookingId = ins.rows[0].id as string;
      await emit(c, g, {
        eventId: p.event_id, eventType: 'booking.created',
        aggregateType: 'booking', aggregateId: bookingId,
        aggregateVersion: 1,
        payload: { status: 'APPROVAL_PENDING', source: 'public_page' },
        traceId: req.traceId,
      });
      await audit(c, g, {
        action: 'booking.public_submit', targetType: 'bookings',
        targetId: bookingId,
        changes: { slug, party_count: b.party_count },
        traceId: req.traceId,
      });
      return bookingId;
    }, {}, { tenantId: p.tenant_id, storeId: p.store_id });
    reply.code(201);
    return { booking_id: out, status: 'APPROVAL_PENDING', trace_id: req.traceId };
  });
}
