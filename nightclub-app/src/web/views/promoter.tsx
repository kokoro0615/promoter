// Promoter role view: guest registration, visit list, notifications inbox,
// own performance (rewards summary from the referrer's perspective).
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { call, uuid } from '../api.js';
import { Err, Pill, Tabs, fmt, useEvents, yen, type Membership } from '../ui.js';

interface Customer {
  id: string; display_name: string; regular_status: string;
  masked_hint: string | null;
}
interface Segment {
  id: string; version: number; status: string; requested_count: number;
  authorized_count: number; first_entered_count: number; remaining_count: number;
  unit_amount_minor: number; currency: string; rule_key: string | null;
  requires_identity_check: boolean;
}
export interface Visit {
  id: string; version: number; reception_name: string; status: string;
  customer_id: string | null; arrival_status: string;
  pass_id: string | null; pass_presence: string | null; segments: Segment[];
}
interface Notif {
  id: string; event_id: string | null; channel: string; status: string;
  scheduled_at: string; payload: Record<string, unknown>; created_at: string;
  read_at: string | null;
}
interface Perf {
  visits?: number; first_entries?: number;
  sales_minor?: number; currency?: string;
}

export function Promoter({ member }: { member: Membership | null }) {
  const storeId = member?.store_id || '';
  const [tab, setTab] = useState<'register' | 'notifications' | 'performance'>('register');
  if (!member) return <p className="dim">Sign in first.</p>;
  return <>
    <Tabs tabs={[['register', 'Guests'], ['notifications', 'Notifications'], ['performance', 'Performance']]}
      cur={tab} onSel={setTab} />
    {tab === 'register' && <Register storeId={storeId} />}
    {tab === 'notifications' && <Notifications storeId={storeId} />}
    {tab === 'performance' && <Performance storeId={storeId} />}
  </>;
}

function Register({ storeId }: { storeId: string }) {
  const { events, eventId, setEventId } = useEvents(storeId);
  const [name, setName] = useState('');
  const [count, setCount] = useState(2);
  const [rule, setRule] = useState('general');
  const [found, setFound] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [err, setErr] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    if (!eventId) return;
    const r = await call<{ items: Visit[] }>(
      'GET', `/stores/${storeId}/events/${eventId}/visits?limit=100`);
    setVisits(r.items);
  }, [storeId, eventId]);
  useEffect(() => { refresh().catch(() => undefined); }, [refresh]);

  const search = async () => {
    setErr(null);
    try {
      const r = await call<{ items: Customer[] }>(
        'GET', `/stores/${storeId}/customers?q=${encodeURIComponent(name)}`);
      setFound(r.items); setCustomerId(r.items.length === 1 ? r.items[0]!.id : null);
    } catch (e) { setErr(e as Error); }
  };
  const submit = async () => {
    setErr(null);
    try {
      await call('POST', `/stores/${storeId}/events/${eventId}/visits`, {
        reception_name: name, planned_count: count,
        customer_id: customerId,
        segments: [{ rule_key: rule, count }],
      }, { idem: uuid() });
      setFound([]); setCustomerId(null); setName('');
      await refresh();
    } catch (e) { setErr(e as Error); }
  };

  return <>
    <div className="card">
      <h1>Guest registration</h1>
      <select value={eventId} onChange={(e) => setEventId(e.target.value)}>
        {events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>
      <div className="row" style={{ marginTop: 10 }}>
        <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="reception name (customer name)" />
        <input style={{ width: 90 }} type="number" min={1} value={count}
          onChange={(e) => setCount(Number(e.target.value))} />
        <select style={{ width: 140 }} value={rule} onChange={(e) => setRule(e.target.value)}>
          <option value="general">General</option>
          <option value="guest_free">Guest free</option>
        </select>
        <button className="ghost" onClick={search}>Search</button>
        <button onClick={submit}>Register</button>
      </div>
      <Err e={err} />
      {found.map((c) => (
        <div className="list-item" key={c.id}>
          <span>{c.display_name} {c.regular_status === 'REGULAR' && <Pill v="REGULAR" />}
            {c.masked_hint && <span className="dim"> {c.masked_hint}</span>}</span>
          <button className="ghost" onClick={() => setCustomerId(c.id)}>
            {customerId === c.id ? 'linked' : 'link customer'}
          </button>
        </div>
      ))}
    </div>
    <VisitList visits={visits} />
  </>;
}

export function VisitList({ visits, children }: {
  visits: Visit[]; children?: (v: Visit) => ReactNode;
}) {
  return <div className="card">
    <h2>Visits</h2>
    {visits.map((v) => (
      <div className="list-item" key={v.id}>
        <div>
          <div>{v.reception_name} <Pill v={v.status} /></div>
          <div className="dim">
            {v.segments.map((s) =>
              `${s.rule_key ?? 'seg'} ${s.authorized_count}/${s.requested_count} in:${s.first_entered_count} ${s.status}`
              + (s.requires_identity_check ? ' [id-check]' : '')).join(' | ')}
          </div>
        </div>
        {children?.(v)}
      </div>
    ))}
    {!visits.length && <p className="dim">none</p>}
  </div>;
}

function Notifications({ storeId }: { storeId: string }) {
  const [items, setItems] = useState<Notif[]>([]);
  const [unread, setUnread] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const refresh = useCallback(async () => {
    const r = await call<{ items: Notif[] }>(
      'GET', `/stores/${storeId}/me/notifications?limit=100${unread ? '&unread_only=true' : ''}`);
    setItems(r.items);
  }, [storeId, unread]);
  useEffect(() => { refresh().catch(setErr); }, [refresh]);
  const mark = async (id: string) => {
    try {
      await call('POST', `/stores/${storeId}/me/notifications/${id}/read`, {});
      await refresh();
    } catch (e) { setErr(e as Error); }
  };
  return <div className="card">
    <div className="row">
      <h2 className="grow">Notifications</h2>
      <label className="dim small row" style={{ gap: 4 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={unread}
          onChange={(e) => setUnread(e.target.checked)} /> unread only
      </label>
    </div>
    {items.map((n) => (
      <div className="list-item" key={n.id}>
        <div>
          <div>{String(n.payload?.title ?? n.payload?.type ?? 'notification')}
            {!n.read_at && <Pill v="UNREAD" />}</div>
          <div className="dim">{fmt(n.created_at)} — {String(n.payload?.body ?? '')}</div>
        </div>
        {!n.read_at && <button className="ghost" onClick={() => mark(n.id)}>mark read</button>}
      </div>
    ))}
    {!items.length && <p className="dim">none</p>}
    <Err e={err} />
  </div>;
}

function Performance({ storeId }: { storeId: string }) {
  const { eventId, picker } = useEvents(storeId);
  const [perf, setPerf] = useState<Perf | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  useEffect(() => {
    if (!eventId) { setPerf(null); return; }
    call<Perf>('GET', `/stores/${storeId}/events/${eventId}/my-performance`)
      .then(setPerf).catch(setErr);
  }, [storeId, eventId]);
  return <div className="card">
    <h2>My performance</h2>
    {picker}
    {perf && <div style={{ marginTop: 10 }}>
      <p>visits referred: <b>{perf.visits ?? 0}</b></p>
      <p>first entries: <b>{perf.first_entries ?? 0}</b></p>
      <p>attributed sales: <b>{yen(perf.sales_minor, perf.currency)}</b></p>
    </div>}
    <Err e={err} />
  </div>;
}
