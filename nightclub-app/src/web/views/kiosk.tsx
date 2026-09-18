// Kiosk (shared entrance device): pairing, operator PIN unlock, entrance
// operations (visits/approvals/entries/passes), ticket redemption, and a
// quick POS order panel — everything an operator does standing at the door
// or the floor till.
import { useCallback, useEffect, useState } from 'react';
import { ApiError, call, opSession, setOpSession, uuid } from '../api.js';
import { Err, Pill, Tabs, fmt, yen, type EventRow } from '../ui.js';
import type { Visit } from './promoter.js';

interface Approval {
  id: string; version: number; segment_version: number; status: string;
  requested_count: number; visit_id: string; reception_name: string;
  requested_by_name: string | null; reason: string | null;
}
interface Customer {
  id: string; display_name: string; regular_status: string;
  masked_hint: string | null;
}
interface Product {
  id: string; name: string; kind: string; price_minor: number;
  currency: string; status: string;
}

export function Kiosk() {
  const [paired, setPaired] = useState<boolean | null>(null);
  const [code, setCode] = useState('');
  const [ops, setOps] = useState<{ membership_id: string; display_name: string }[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [current, setCurrent] = useState<{ operator_session_id: string; display_name: string; event_id?: string } | null>(null);
  const [sel, setSel] = useState({ membership_id: '', event_id: '', pin: '' });
  const [err, setErr] = useState<Error | null>(null);

  const [storeId, setStoreId] = useState('');
  const loadOps = useCallback(async () => {
    const r = await call<{
      items: typeof ops;
      current_operator: { operator_session_id: string; display_name: string; event_id?: string } | null;
      events: EventRow[]; device_id: string; store_id: string;
    }>('GET', '/device/operators');
    setOps(r.items); setEvents(r.events); setCurrent(r.current_operator);
    setStoreId(r.store_id);
    setPaired(true);
  }, []);
  useEffect(() => { loadOps().catch(() => setPaired(false)); }, [loadOps]);

  const pair = async () => {
    setErr(null);
    try {
      await call('POST', '/device/enroll', { pairing_code: code });
      setPaired(true); await loadOps();
    } catch (e) { setErr(e as Error); }
  };
  const unlock = async () => {
    setErr(null);
    try {
      const r = await call<{ operator_session_id: string }>(
        'POST', '/device/operator-sessions', sel);
      setOpSession(r.operator_session_id);
      setSel((s) => ({ ...s, pin: '' }));
      await loadOps();
    } catch (e) { setErr(e as Error); }
  };
  const handoff = async () => {
    await call('POST', '/device/operator-sessions/end', {}).catch(() => undefined);
    setOpSession(null); setCurrent(null);
    await loadOps().catch(() => undefined);
  };

  if (paired === false) {
    return <div className="card">
      <h1>Pair this device</h1>
      <p className="dim">Enter the pairing code issued from the admin screen.</p>
      <div className="row">
        <input className="grow" value={code} onChange={(e) => setCode(e.target.value)} placeholder="pairing code" />
        <button onClick={pair}>Pair</button>
      </div>
      <Err e={err} />
    </div>;
  }
  if (paired === null) return <p className="dim">…</p>;
  if (!current || !opSession()) {
    return <div className="card">
      <h1>Operator unlock</h1>
      <p className="dim">Shared device — each operator identifies themselves by PIN.</p>
      <div className="grid">
        <select value={sel.membership_id}
          onChange={(e) => setSel({ ...sel, membership_id: e.target.value })}>
          <option value="">operator…</option>
          {ops.map((o) => <option key={o.membership_id} value={o.membership_id}>{o.display_name}</option>)}
        </select>
        <select value={sel.event_id}
          onChange={(e) => setSel({ ...sel, event_id: e.target.value })}>
          <option value="">event…</option>
          {events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <input type="password" inputMode="numeric" value={sel.pin}
          onChange={(e) => setSel({ ...sel, pin: e.target.value })} placeholder="PIN" />
        <button onClick={unlock}>Unlock</button>
        <Err e={err} />
      </div>
    </div>;
  }
  return <Floor storeId={storeId}
    eventId={sel.event_id || current.event_id || ''}
    onHandoff={handoff} />;
}

function Floor({ storeId, eventId, onHandoff }:
  { storeId: string; eventId: string; onHandoff: () => void }) {
  const [tab, setTab] = useState<'entrance' | 'tickets' | 'pos'>('entrance');
  return <>
    <div className="row" style={{ marginBottom: 8 }}>
      <h2 className="grow" style={{ margin: 0 }}>Kiosk</h2>
      <button className="ghost" onClick={onHandoff}>Switch operator</button>
    </div>
    <Tabs tabs={[['entrance', 'Entrance'], ['tickets', 'Tickets'], ['pos', 'POS']]}
      cur={tab} onSel={setTab} />
    {tab === 'entrance' && <Entrance storeId={storeId} eventId={eventId} />}
    {tab === 'tickets' && <Tickets storeId={storeId} eventId={eventId} />}
    {tab === 'pos' && <Pos storeId={storeId} eventId={eventId} />}
  </>;
}

function Entrance({ storeId, eventId }: { storeId: string; eventId: string }) {
  const [visits, setVisits] = useState<Visit[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Customer[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    if (!storeId || !eventId) return;
    const [v, a] = await Promise.all([
      call<{ items: Visit[] }>('GET', `/stores/${storeId}/events/${eventId}/visits?limit=200`),
      call<{ items: Approval[] }>('GET', `/stores/${storeId}/events/${eventId}/approvals?status=PENDING`),
    ]);
    setVisits(v.items); setApprovals(a.items);
  }, [storeId, eventId]);
  useEffect(() => {
    refresh().catch(setErr);
    if (!storeId || !eventId) return;
    const es = new EventSource(`/api/stores/${storeId}/events/${eventId}/stream`);
    es.onmessage = () => refresh().catch(() => undefined);
    return () => es.close();
  }, [refresh, storeId, eventId]);

  const search = async () => {
    setErr(null);
    const r = await call<{ items: Customer[] }>(
      'GET', `/stores/${storeId}/customers?q=${encodeURIComponent(q)}`);
    setFound(r.items);
  };
  const decide = async (a: Approval, decision: 'APPROVED' | 'REJECTED') => {
    setErr(null);
    try {
      await call('POST', `/stores/${storeId}/events/${eventId}/approvals/${a.id}/decisions`, {
        expected_request_version: a.version,
        expected_segment_version: a.segment_version,
        decision,
      }, { idem: uuid() });
    } catch (e) { setErr(e as Error); }
    await refresh();
  };
  const check = async (v: Visit) => {
    setErr(null);
    const c = found.find((x) => x.id === v.customer_id) ?? found[0];
    if (!c) { setErr(new ApiError(0, { code: 'NO_CANDIDATE', detail: 'search and pick a customer first' })); return; }
    try {
      await call('POST', `/stores/${storeId}/events/${eventId}/visits/${v.id}/customer-checks`, {
        customer_id: c.id, method: 'KNOWN_BY_STAFF',
      }, { idem: uuid() });
      setChecked((m) => ({ ...m, [v.id]: true }));
    } catch (e) { setErr(e as Error); }
  };
  const enter = async (v: Visit, s: Visit['segments'][0], n: number) => {
    setErr(null);
    try {
      await call('POST', `/stores/${storeId}/events/${eventId}/visits/${v.id}/entries`, {
        expected_visit_version: v.version,
        selections: [{ segment_id: s.id, count: n }],
      }, { idem: uuid() });
      await refresh();
    } catch (e) { setErr(e as Error); await refresh(); }
  };
  const move = async (v: Visit, kind: 'exit' | 'reentry') => {
    setErr(null);
    if (!v.pass_id) return;
    try {
      await call('POST', `/stores/${storeId}/events/${eventId}/passes/${kind}`, {
        pass_id: v.pass_id, quantity: 1,
      }, { idem: uuid() });
      await refresh();
    } catch (e) { setErr(e as Error); }
  };

  return <>
    <div className="card">
      <h1>Entrance</h1>
      <div className="row">
        <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="name search" />
        <button className="ghost" onClick={search}>Search</button>
      </div>
      {found.map((c) => (
        <div className="list-item" key={c.id}>
          <span>{c.display_name} {c.regular_status === 'REGULAR' && <Pill v="REGULAR" />}
            {c.masked_hint && <span className="dim"> {c.masked_hint}</span>}</span>
        </div>
      ))}
      <Err e={err} />
    </div>
    {approvals.length > 0 && <div className="card">
      <h2>Pending approvals ({approvals.length})</h2>
      {approvals.map((a) => (
        <div className="list-item" key={a.id}>
          <span>{a.reception_name} ×{a.requested_count}
            {a.requested_by_name && <span className="dim"> by {a.requested_by_name}</span>}</span>
          <span className="row">
            <button onClick={() => decide(a, 'APPROVED')}>Approve</button>
            <button className="danger" onClick={() => decide(a, 'REJECTED')}>Reject</button>
          </span>
        </div>
      ))}
    </div>}
    <div className="card">
      <h2>Visits</h2>
      {visits.map((v) => (
        <div className="list-item" key={v.id}>
          <div>
            <div>{v.reception_name} <Pill v={v.status} />
              {v.pass_presence && <Pill v={v.pass_presence} />}</div>
            <div className="dim">
              {v.segments.map((s) =>
                `${s.rule_key ?? 'seg'} ${s.authorized_count}/${s.requested_count} in:${s.first_entered_count} ${s.status}`).join(' | ')}
            </div>
          </div>
          <span className="row">
            {v.segments.filter((s) => s.status === 'AUTHORIZED' && s.remaining_count > 0).map((s) => (
              <span key={s.id} className="row">
                {s.requires_identity_check && !checked[v.id] &&
                  <button className="ghost" onClick={() => check(v)}>confirm id</button>}
                <button onClick={() => enter(v, s, 1)}>in +1</button>
                {s.remaining_count > 1 &&
                  <button onClick={() => enter(v, s, s.remaining_count)}>in +{s.remaining_count}</button>}
              </span>
            ))}
            {v.pass_id && v.pass_presence === 'INSIDE' &&
              <button className="ghost" onClick={() => move(v, 'exit')}>exit</button>}
            {v.pass_id && v.pass_presence === 'OUTSIDE' &&
              <button className="ghost" onClick={() => move(v, 'reentry')}>re-entry</button>}
          </span>
        </div>
      ))}
      {!visits.length && <p className="dim">no visits</p>}
    </div>
  </>;
}

// Ticket redemption: scan/paste a single-use token -> visit + TICKET segment.
function Tickets({ storeId, eventId }: { storeId: string; eventId: string }) {
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const redeem = async () => {
    setErr(null); setMsg('');
    try {
      const r = await call<{ visit_id: string; ticket_id: string }>(
        'POST', `/stores/${storeId}/events/${eventId}/tickets/redeem`,
        { token }, { idem: uuid() });
      setMsg(`redeemed — visit ${r.visit_id}`); setToken('');
    } catch (e) { setErr(e as Error); }
  };
  return <div className="card">
    <h1>Ticket redeem</h1>
    <p className="dim">Scan or paste the guest's ticket token (QR payload).</p>
    <div className="grid">
      <input className="mono" value={token} onChange={(e) => setToken(e.target.value)}
        placeholder="ticket token" />
      <div className="row"><button onClick={redeem}>Redeem</button></div>
      {msg && <p className="ok">{msg}</p>}
      <Err e={err} />
    </div>
  </div>;
}

// Quick POS order: pick products, record a sale against the event.
function Pos({ storeId, eventId }: { storeId: string; eventId: string }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [method, setMethod] = useState<'CASH' | 'EXTERNAL_TERMINAL'>('CASH');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  useEffect(() => {
    if (!storeId) return;
    call<{ items: Product[] }>('GET', `/stores/${storeId}/products`)
      .then((r) => setProducts(r.items.filter((p) => p.status === 'ACTIVE')))
      .catch(setErr);
  }, [storeId]);
  const total = products.reduce((sum, p) => sum + (cart[p.id] ?? 0) * p.price_minor, 0);
  const submit = async () => {
    setErr(null); setMsg('');
    try {
      const lines = Object.entries(cart)
        .filter(([, n]) => n > 0)
        .map(([product_id, quantity]) => ({ product_id, quantity }));
      const r = await call<{ order_id: string }>(
        'POST', `/stores/${storeId}/events/${eventId}/pos/orders`,
        { lines, method }, { idem: uuid() });
      setMsg(`order ${r.order_id} recorded`); setCart({});
    } catch (e) { setErr(e as Error); }
  };
  return <div className="card">
    <h1>POS</h1>
    {products.map((p) => (
      <div className="list-item" key={p.id}>
        <span>{p.name} <span className="dim">{yen(p.price_minor, p.currency)}</span></span>
        <span className="row">
          <button className="ghost" onClick={() =>
            setCart((c) => ({ ...c, [p.id]: Math.max(0, (c[p.id] ?? 0) - 1) }))}>−</button>
          <span className="mono">{cart[p.id] ?? 0}</span>
          <button className="ghost" onClick={() =>
            setCart((c) => ({ ...c, [p.id]: (c[p.id] ?? 0) + 1 }))}>＋</button>
        </span>
      </div>
    ))}
    {!products.length && <p className="dim">no active products — manage them in Admin → Inventory</p>}
    <div className="row" style={{ marginTop: 10 }}>
      <select style={{ width: 200 }} value={method}
        onChange={(e) => setMethod(e.target.value as 'CASH' | 'EXTERNAL_TERMINAL')}>
        <option value="CASH">Cash</option>
        <option value="EXTERNAL_TERMINAL">External terminal</option>
      </select>
      <b className="grow">total {yen(total)}</b>
      <button onClick={submit} disabled={!total}>Charge</button>
    </div>
    {msg && <p className="ok">{msg}</p>}
    <Err e={err} />
  </div>;
}
