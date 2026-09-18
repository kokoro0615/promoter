// Public booking pages: admin CRUD + unauthenticated lookup/submit.
import { describe, expect, it } from 'vitest';
import { call, devLogin, seed } from '../helpers.js';
import { randomUUID } from 'node:crypto';

const idem = () => `pb-${randomUUID()}`;

describe('public booking pages', () => {
  it('admin creates a page; public form reads it; submission lands APPROVAL_PENDING', async () => {
    const cookies = await devLogin('admin');
    const s = seed();
    const base = `/stores/${s.store}/events/${s.event}`;
    // Create the page.
    const mk = await call('POST', `${base}/booking-pages`,
      { cookies, idem: idem() },
      { title: 'Weekend VIP', message: 'reserve a table',
        collect_phone: true, max_party: 6 });
    expect(mk.status).toBe(201);
    const slug = mk.body.slug as string;
    expect(slug).toBeTruthy();
    expect(mk.body.url).toBe(`/#/book/${slug}`);

    // Public lookup — no cookies at all.
    const page = await call('GET', `/public/booking-pages/${slug}`);
    expect(page.status).toBe(200);
    expect(page.body.title).toBe('Weekend VIP');
    expect(page.body.event_name).toBeTruthy();
    expect(page.body.store_name).toBeTruthy();

    // Submission without required phone -> rejected.
    const noPhone = await call('POST',
      `/public/booking-pages/${slug}/submissions`, {},
      { name: 'Tanaka', party_count: 2, starts_at: '2027-01-01T22:00:00+09:00' });
    expect(noPhone.status).toBe(422);
    // Over max_party -> rejected.
    const tooBig = await call('POST',
      `/public/booking-pages/${slug}/submissions`, {},
      { name: 'Tanaka', phone: '090', party_count: 7,
        starts_at: '2027-01-01T22:00:00+09:00' });
    expect(tooBig.status).toBe(422);
    // Valid submission.
    const sub = await call('POST',
      `/public/booking-pages/${slug}/submissions`, {},
      { name: 'Tanaka', phone: '090-1111-2222', note: 'birthday',
        party_count: 4, starts_at: '2027-01-01T22:00:00+09:00' });
    expect(sub.status).toBe(201);
    expect(sub.body.status).toBe('APPROVAL_PENDING');
    const bookingId = sub.body.booking_id as string;

    // Staff sees the pending booking in the normal list, contact attached.
    const list = await call('GET', `${base}/bookings`, { cookies });
    expect(list.status).toBe(200);
    const row = (list.body.items as { id: string; status: string }[])
      .find((x) => x.id === bookingId);
    expect(row?.status).toBe('APPROVAL_PENDING');
  });

  it('closing a page removes it from public lookup', async () => {
    const cookies = await devLogin('admin');
    const s = seed();
    const base = `/stores/${s.store}/events/${s.event}`;
    const mk = await call('POST', `${base}/booking-pages`,
      { cookies, idem: idem() }, { title: 'Close me' });
    const slug = mk.body.slug as string;
    const pages = await call('GET', `${base}/booking-pages`, { cookies });
    const row = (pages.body.items as { id: string; version: number; slug: string }[])
      .find((p) => p.slug === slug)!;
    const close = await call('POST',
      `${base}/booking-pages/${row.id}/status`, { cookies, idem: idem() },
      { status: 'CLOSED', expected_version: row.version });
    expect(close.status).toBe(200);
    const gone = await call('GET', `/public/booking-pages/${slug}`);
    expect(gone.status).toBe(404);
  });

  it('rejects an unknown slug without leaking internals', async () => {
    const r = await call('GET', '/public/booking-pages/no-such-page-xyz');
    expect(r.status).toBe(404);
    const sub = await call('POST',
      '/public/booking-pages/no-such-page-xyz/submissions', {},
      { name: 'X', party_count: 1, starts_at: '2027-01-01T22:00:00+09:00' });
    expect(sub.status).toBe(404);
  });
});
