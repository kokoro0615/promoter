import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { call, ApiError, opSession, setOpSession, uuid } from './api.js';

type Route = 'login' | 'promoter' | 'kiosk' | 'admin';
const routeOf = (): Route => {
  const h = location.hash.replace(/^#\/?/, '');
  return (['login', 'promoter', 'kiosk', 'admin'] as const).includes(h as Route)
    ? h as Route : 'login';
};

interface Membership {
  membership_id: string; tenant_id: string; store_id: string;
  display_name: string; status: string; store_name: string;
  permissions: string[] | null;
}
interface Me {
  user_id?: string; display_name?: string | null; memberships?: Membership[];
  device?: boolean;
}
interface Customer { id: string; display_name: string; regular_status: string; masked_hint: string | null }
interface Segment {
  id: string; version: number; status: string; requested_count: number;
  authorized_count: number; first_entered_count: number; remaining_count: number;
  unit_amount_minor: number; currency: string; rule_key: string | null;
  requires_identity_check: boolean;
}
interface Visit {
  id: string; version: number; reception_name: string; status: string;
  customer_id: string | null; arrival_status: string;
  pass_id: string | null; pass_presence: string | null; segments: Segment[];
}
interface Approval {
  id: string; version: number; segment_version: number; status: string;
  requested_count: number; visit_id: string; reception_name: string;
  requested_by_name: string | null; reason: string | null;
}
interface EventRow { id: string; name: string; status: string }

export function App() {
  const [route, setRoute] = useState<Route>(routeOf());
  const [me, setMe] = useState<Me | null>(null);
  const refresh = useCallback(() => {
    call<Me>('GET', '/me').then(setMe).catch(() => setMe({}));
  }, []);
  useEffect(() => {
    const on = () => setRoute(routeOf());
    addEventListener('hashchange', on);
    refresh();
    return () => removeEventListener('hashchange', on);
  }, [refresh]);
  const member = me?.memberships?.find((m) => m.status === 'ACTIVE') ?? null;
  return <>
    <nav>
      <a href="#/login" className={route === 'login' ? 'active' : ''}>Login</a>
      <a href="#/promoter" className={route === 'promoter' ? 'active' : ''}>Promoter</a>
      <a href="#/kiosk" className={route === 'kiosk' ? 'active' : ''}>Kiosk</a>
      <a href="#/admin" className={route === 'admin' ? 'active' : ''}>Admin</a>
      {me?.display_name && <span className="dim" style={{ padding: '8px 0' }}>{me.display_name}</span>}
    </nav>
    <main>
      {route === 'login' && <Login me={me} onChange={refresh} />}
      {route === 'promoter' && <Promoter member={member} />}
      {route === 'kiosk' && <Kiosk />}
      {route === 'admin' && <Admin member={member} />}
    </main>
  </>;
}

function Err({ e }: { e: Error | null }) {
  return e ? <p className="err">{(e as ApiError).code}: {e.message}</p> : null;
}

// ---- login ----
function Login({ me, onChange }: { me: Me | null; onChange: () => void }) {
  const [subject, setSubject] = useState('dev-admin');
  const [name, setName] = useState('Admin User');
  const [err, setErr] = useState<Error | null>(null);
  const login = async () => {
    setErr(null);
    try {
      await call('POST', '/auth/dev/login', { subject, display_name: name });
      onChange();
    } catch (e) { setErr(e as Error); }
  };
  const logout = async () => {
    await call('POST', '/auth/logout', {}).catch(() => undefined);
    onChange();
  };
  return <div className="card">
    <h1>Sign in</h1>
    <p className="dim">Dev-issuer login (OIDC dev adapter). One personal session carries every membership.</p>
    <div className="grid">
      <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="subject" />
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="display name" />
      <div className="row">
        <button onClick={login}>Sign in</button>
        <button className="ghost" onClick={logout}>Sign out</button>
      </div>
      <Err e={err} />
      {me?.user_id && <>
        <p className="ok">signed in as {me.display_name}</p>
        {me.memberships?.map((m) => (
          <p className="dim" key={m.membership_id}>
            {m.store_name} — {m.display_name} ({m.permissions?.length ?? 0} permissions)
          </p>
        ))}
      </>}
    </div>
  </div>;
}

// ---- promoter ----
function Promoter({ member }: { member: Membership | null }) {
  const storeId = member?.store_id || '';
  const [events, setEvents] = useState<EventRow[]>([]);
  const [eventId, setEventId] = useState('');
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

  useEffect(() => {
    if (!storeId) return;
    call<{ items: EventRow[] }>('GET', `/stores/${storeId}/events`)
      .then((r) => { setEvents(r.items); if (r.items[0]) setEventId(r.items[0].id); })
      .catch(setErr);
  }, [storeId]);
  useEffect(() => { refresh().catch(() => undefined); }, [refresh]);

  const search = async () => {
    setErr(null);
    const r = await call<{ items: Customer[] }>(
      'GET', `/stores/${storeId}/customers?q=${encodeURIComponent(name)}`);
    setFound(r.items); setCustomerId(r.items.length === 1 ? r.items[0]!.id : null);
  };
  const submit = async () => {
    setErr(null);
    try {
      await call('POST', `/stores/${storeId}/events/${eventId}/visits`, {
        reception_name: name, planned_count: count,
        customer_id: customerId,
        segments: [{ rule_key: rule, count }],
      }, { idem: uuid() });
      setFound([]); setCustomerId(null);
      await refresh();
    } catch (e) { setErr(e as Error); }
  };
  if (!member) return <p className="dim">Sign in first.</p>;
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
          <span>{c.display_name} {c.regular_status === 'REGULAR' && <span className="pill">REGULAR</span>}
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

function VisitList({ visits, children }: {
  visits: Visit[]; children?: (v: Visit) => ReactNode;
}) {
  return <div className="card">
    <h2>Visits</h2>
    {visits.map((v) => (
      <div className="list-item" key={v.id}>
        <div>
          <div>{v.reception_name} <span className={`pill ${v.status}`}>{v.status}</span></div>
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

// ---- kiosk (shared device) ----
function Kiosk() {
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
  return <Entrance storeId={storeId}
    eventId={sel.event_id || current.event_id || ''}
    onHandoff={handoff} />;
}

function Entrance({ storeId, eventId, onHandoff }:
  { storeId: string; eventId: string; onHandoff: () => void }) {
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
    if (!c) { setErr(new ApiError(0, { error: { code: 'NO_CANDIDATE', message: 'search and pick a customer first' } })); return; }
    try {
      await call('POST', `/stores/${storeId}/events/${eventId}/visits/${v.id}/customer-checks`, {
        customer_id: c.id, method: 'KNOWN_BY_STAFF',
      }, { idem: uuid() });
      setChecked((m) => ({ ...m, [v.id]: true }));
    } catch (e) { setErr(e as Error); }
  };
  const enter = async (v: Visit, s: Segment, n: number) => {
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
      <div className="row">
        <h1 className="grow">Entrance</h1>
        <button className="ghost" onClick={onHandoff}>Switch operator</button>
      </div>
      <div className="row">
        <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="name search" />
        <button className="ghost" onClick={search}>Search</button>
      </div>
      {found.map((c) => (
        <div className="list-item" key={c.id}>
          <span>{c.display_name} {c.regular_status === 'REGULAR' && <span className="pill">REGULAR</span>}
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
            <div>{v.reception_name} <span className={`pill ${v.status}`}>{v.status}</span>
              {v.pass_presence && <span className="pill">{v.pass_presence}</span>}</div>
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

// ---- admin ----
function Admin({ member }: { member: Membership | null }) {
  const storeId = member?.store_id || '';
  const [events, setEvents] = useState<EventRow[]>([]);
  const [audit, setAudit] = useState<{ id: string; action: string; actor_display: string | null; created_at: string }[]>([]);
  const [label, setLabel] = useState('Entrance iPad');
  const [pairCode, setPairCode] = useState('');
  const [err, setErr] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    if (!storeId) return;
    const [e, a] = await Promise.all([
      call<{ items: EventRow[] }>('GET', `/stores/${storeId}/events`),
      call<{ items: typeof audit }>('GET', `/stores/${storeId}/audit-logs?limit=30`),
    ]);
    setEvents(e.items); setAudit(a.items);
  }, [storeId]);
  useEffect(() => { refresh().catch(setErr); }, [refresh]);

  const enroll = async () => {
    setErr(null);
    try {
      const r = await call<{ pairing_code: string; expires_at: string }>(
        'POST', `/stores/${storeId}/devices/enrollments`, { label });
      setPairCode(r.pairing_code);
    } catch (e) { setErr(e as Error); }
  };
  if (!member) return <p className="dim">Sign in first.</p>;
  return <>
    <div className="card"><h1>Events</h1>
      {events.map((e) => <div className="list-item" key={e.id}>
        <span>{e.name}</span><span className={`pill ${e.status}`}>{e.status}</span></div>)}
    </div>
    <div className="card">
      <h2>Pair entrance device</h2>
      <div className="row">
        <input className="grow" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="device label" />
        <button onClick={enroll}>Issue pairing code</button>
      </div>
      {pairCode && <p className="ok">pairing code: <code>{pairCode}</code> (valid 10 min)</p>}
      <Err e={err} />
    </div>
    <div className="card"><h2>Audit log</h2>
      {audit.map((a) => <div className="list-item" key={a.id}>
        <span className="dim">{new Date(a.created_at).toLocaleString()}</span>
        <span>{a.actor_display ?? '—'}</span><span>{a.action}</span></div>)}
    </div>
  </>;
}
