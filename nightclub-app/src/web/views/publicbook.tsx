// Unauthenticated public booking form reached via /#/book/:slug.
// Renders the page's safe public fields and submits an APPROVAL_PENDING
// booking request. No session required.
import { useCallback, useEffect, useState } from 'react';
import { call } from '../api.js';
import { Err, fmt, yen } from '../ui.js';

interface Page {
  title: string; message: string | null; collect_phone: boolean;
  max_party: number; store_name: string; event_name: string;
  event_starts_at: string; currency: string;
}

export function PublicBook({ slug }: { slug: string }) {
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [f, setF] = useState({ name: '', phone: '', note: '', party: 2, at: '' });

  const load = useCallback(async () => {
    const p = await call<Page>('GET', `/public/booking-pages/${slug}`);
    setPage(p);
    setF((v) => ({ ...v, at: p.event_starts_at.slice(0, 16) }));
  }, [slug]);
  useEffect(() => {
    load().catch(setErr).finally(() => setLoading(false));
  }, [load]);

  const submit = async () => {
    setErr(null); setBusy(true);
    try {
      const startsAt = new Date(f.at).toISOString();
      await call('POST', `/public/booking-pages/${slug}/submissions`, {
        name: f.name, phone: f.phone || undefined, note: f.note || undefined,
        party_count: f.party, starts_at: startsAt,
      });
      setDone(true);
    } catch (e) { setErr(e as Error); }
    finally { setBusy(false); }
  };

  if (loading) return <div className="card"><p className="dim">Loading…</p></div>;
  if (!page) return <div className="card">
    <h1>Booking</h1><Err e={err} />
    <p className="dim">This booking page is not available.</p>
  </div>;
  if (done) return <div className="card">
    <h1>{page.title}</h1>
    <p className="ok">Request received — the venue will confirm shortly.</p>
    <p className="dim">You can close this page.</p>
  </div>;

  return <div className="card">
    <p className="dim">{page.store_name}</p>
    <h1>{page.title}</h1>
    <p className="dim">{page.event_name} · {fmt(page.event_starts_at)} ·
      {' '}max party {page.max_party}</p>
    {page.message && <p>{page.message}</p>}
    <div className="grid">
      <label className="f">Name
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </label>
      {page.collect_phone && <label className="f">Phone
        <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
      </label>}
      <label className="f">Party size
        <input type="number" min={1} max={page.max_party} value={f.party}
          onChange={(e) => setF({ ...f, party: Number(e.target.value) })} />
      </label>
      <label className="f">Arrival time
        <input type="datetime-local" value={f.at}
          onChange={(e) => setF({ ...f, at: e.target.value })} />
      </label>
      <label className="f">Note (optional)
        <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </label>
      <button disabled={busy || !f.name || !f.at}
        onClick={submit}>{busy ? 'Sending…' : 'Request booking'}</button>
    </div>
    <Err e={err} />
  </div>;
}
