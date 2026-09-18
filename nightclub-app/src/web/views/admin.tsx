// Admin role view — store operations console. Tabs: events, bookings,
// floor, tickets, inventory, crm, finance, ops, members, devices, audit,
// settings. Everything is wired to real endpoints; forms use the same
// command/idempotency conventions as the API.
import { useCallback, useEffect, useState } from 'react';
import { call, uuid } from '../api.js';
import { Err, Pill, Table, Tabs, fmt, useEvents, yen, type Membership } from '../ui.js';
import { Bookings, Floor, Tickets, Inventory, Crm, Finance, Ops } from './adminevt.js';

interface AuditRow {
  id: string; action: string; actor_display: string | null;
  created_at: string; target_type: string;
}

type Tab = 'events' | 'bookings' | 'floor' | 'tickets' | 'inventory' | 'crm'
  | 'finance' | 'ops' | 'members' | 'devices' | 'audit' | 'settings';

export function Admin({ member }: { member: Membership | null }) {
  const storeId = member?.store_id || '';
  const [tab, setTab] = useState<Tab>('events');
  if (!member) return <p className="dim">Sign in first.</p>;
  const tabs: [Tab, string][] = [
    ['events', 'Events'], ['bookings', 'Bookings'], ['floor', 'Floor'],
    ['tickets', 'Tickets'], ['inventory', 'Inventory'], ['crm', 'CRM'],
    ['finance', 'Finance'], ['ops', 'Ops'], ['members', 'Members'],
    ['devices', 'Devices'], ['audit', 'Audit'], ['settings', 'Settings'],
  ];
  return <>
    <Tabs tabs={tabs} cur={tab} onSel={setTab} />
    {tab === 'events' && <EventsTab storeId={storeId} />}
    {tab === 'bookings' && <Bookings storeId={storeId} />}
    {tab === 'floor' && <Floor storeId={storeId} />}
    {tab === 'tickets' && <Tickets storeId={storeId} />}
    {tab === 'inventory' && <Inventory storeId={storeId} />}
    {tab === 'crm' && <Crm storeId={storeId} />}
    {tab === 'finance' && <Finance storeId={storeId} />}
    {tab === 'ops' && <Ops storeId={storeId} />}
    {tab === 'members' && <MembersTab storeId={storeId} />}
    {tab === 'devices' && <DevicesTab storeId={storeId} />}
    {tab === 'audit' && <AuditTab storeId={storeId} />}
    {tab === 'settings' && <SettingsTab storeId={storeId} />}
  </>;
}

// ---- events + policy ----
function EventsTab({ storeId }: { storeId: string }) {
  const { events, eventId, picker } = useEvents(storeId);
  const [rows, setRows] = useState(events);
  const [form, setForm] = useState({ name: '', opens_at: '', closes_at: '' });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const refresh = useCallback(async () => {
    const r = await call<{ items: typeof rows }>('GET', `/stores/${storeId}/events`);
    setRows(r.items);
  }, [storeId]);
  useEffect(() => { refresh().catch(setErr); }, [refresh]);
  useEffect(() => setRows(events), [events]);

  const ev = events.find((e) => e.id === eventId);
  const create = async () => {
    setErr(null); setMsg('');
    try {
      await call('POST', `/stores/${storeId}/events`, {
        name: form.name,
        opens_at: new Date(form.opens_at).toISOString(),
        closes_at: new Date(form.closes_at).toISOString(),
      });
      setForm({ name: '', opens_at: '', closes_at: '' });
      setMsg('event created (DRAFT)'); await refresh();
    } catch (e) { setErr(e as Error); }
  };
  const act = async (path: string, body: unknown = {}) => {
    setErr(null); setMsg('');
    try {
      const r = await call<{ status?: string; name?: string }>(
        'POST', `/stores/${storeId}/events/${eventId}/${path}`, body,
        { idem: uuid() });
      setMsg(`${path}: ${r.status ?? 'ok'}${r.name ? ` ${r.name}` : ''}`);
      await refresh();
    } catch (e) { setErr(e as Error); }
  };

  return <>
    <div className="card">
      <h1>Events</h1>
      <Table cols={['name', 'status', 'opens', 'closes', 'actions']}
        rows={rows.map((e) => [
          e.name, <Pill v={e.status} />, fmt(e.opens_at), fmt(e.closes_at),
          e.id === eventId ? <b>selected</b> : null,
        ])} />
      <h3>Actions on {ev?.name ?? '—'}</h3>
      {picker}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="ghost" onClick={() => act('publish')}>Publish event</button>
        <button className="ghost" onClick={() => act('duplicate')}>Duplicate</button>
        <button className="danger" onClick={() => act('cancel', { expected_version: ev?.version })}>Cancel</button>
      </div>
      <Err e={err} />
      {msg && <p className="ok">{msg}</p>}
    </div>
    <div className="card">
      <h2>New event</h2>
      <div className="grid">
        <input value={form.name} placeholder="event name"
          onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <label className="f">opens at</label>
        <input type="datetime-local" value={form.opens_at}
          onChange={(e) => setForm({ ...form, opens_at: e.target.value })} />
        <label className="f">closes at</label>
        <input type="datetime-local" value={form.closes_at}
          onChange={(e) => setForm({ ...form, closes_at: e.target.value })} />
        <div className="row"><button onClick={create}>Create</button></div>
      </div>
    </div>
    <Policy storeId={storeId} eventId={eventId} />
  </>;
}

interface PolicyVer { id: string; version: number; status: string; created_at: string }
function Policy({ storeId, eventId }: { storeId: string; eventId: string }) {
  const [vers, setVers] = useState<PolicyVer[]>([]);
  const [err, setErr] = useState<Error | null>(null);
  const [msg, setMsg] = useState('');
  const refresh = useCallback(async () => {
    if (!eventId) { setVers([]); return; }
    const r = await call<{ items: PolicyVer[] }>(
      'GET', `/stores/${storeId}/events/${eventId}/policy-versions`);
    setVers(r.items);
  }, [storeId, eventId]);
  useEffect(() => { refresh().catch(() => setVers([])); }, [refresh]);
  const publish = async (p: PolicyVer) => {
    setErr(null); setMsg('');
    try {
      await call('POST',
        `/stores/${storeId}/events/${eventId}/policy-versions/${p.id}/publish`,
        { expected_version: p.version }, { idem: uuid() });
      setMsg(`policy v${p.version} published`); await refresh();
    } catch (e) { setErr(e as Error); }
  };
  return <div className="card">
    <h2>Policy versions</h2>
    <Table cols={['version', 'status', 'created', '']} rows={vers.map((p) => [
      `v${p.version}`, <Pill v={p.status} />, fmt(p.created_at),
      p.status === 'DRAFT'
        ? <button className="ghost" onClick={() => publish(p)}>Publish</button> : null,
    ])} />
    {msg && <p className="ok">{msg}</p>}
    <Err e={err} />
  </div>;
}

// ---- members + invitations + roles ----
interface MemberRow {
  id: string; user_id: string; display_name: string; status: string;
  version: number; role_keys: string[] | null; has_pin: boolean;
}
interface RoleRow { id: string; role_key: string; name: string; version: number; permissions: string[] }
function MembersTab({ storeId }: { storeId: string }) {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [invite, setInvite] = useState({ target: 'STAFF', role: '', hours: 72 });
  const [inviteUrl, setInviteUrl] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const refresh = useCallback(async () => {
    const [m, r] = await Promise.all([
      call<{ items: MemberRow[] }>('GET', `/stores/${storeId}/memberships`),
      call<{ items: RoleRow[] }>('GET', `/stores/${storeId}/roles`),
    ]);
    setMembers(m.items); setRoles(r.items);
    setInvite((v) => ({ ...v, role: v.role || r.items[0]?.role_key || '' }));
  }, [storeId]);
  useEffect(() => { refresh().catch(setErr); }, [refresh]);
  const suspend = async (m: MemberRow) => {
    setErr(null);
    try {
      await call('POST', `/stores/${storeId}/memberships/${m.id}/suspend`,
        { expected_version: m.version });
      await refresh();
    } catch (e) { setErr(e as Error); }
  };
  const mkInvite = async () => {
    setErr(null); setInviteUrl('');
    try {
      const r = await call<{ token: string; expires_at: string }>(
        'POST', `/stores/${storeId}/invitations`,
        { invite_target: invite.target, role_key: invite.role || undefined,
          expires_hours: invite.hours });
      setInviteUrl(`${location.origin}/#/invite/${r.token}`);
    } catch (e) { setErr(e as Error); }
  };
  return <>
    <div className="card">
      <h1>Members</h1>
      <Table cols={['name', 'status', 'roles', 'pin', '']} rows={members.map((m) => [
        m.display_name, <Pill v={m.status} />,
        (m.role_keys ?? []).join(', ') || '—',
        m.has_pin ? 'set' : '—',
        m.status === 'ACTIVE'
          ? <button className="danger" onClick={() => suspend(m)}>Suspend</button> : null,
      ])} />
      <Err e={err} />
    </div>
    <div className="card">
      <h2>Invite member</h2>
      <div className="row">
        <select value={invite.target}
          onChange={(e) => setInvite({ ...invite, target: e.target.value })}>
          <option value="STAFF">Staff</option>
          <option value="REFERRER">Referrer</option>
        </select>
        <select value={invite.role}
          onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
          {roles.map((r) => <option key={r.id} value={r.role_key}>{r.name}</option>)}
        </select>
        <input style={{ width: 100 }} type="number" value={invite.hours}
          onChange={(e) => setInvite({ ...invite, hours: Number(e.target.value) })} />
        <button onClick={mkInvite}>Issue invitation</button>
      </div>
      {inviteUrl && <p className="ok">invitation: <code>{inviteUrl}</code></p>}
    </div>
    <div className="card">
      <h2>Roles</h2>
      <Table cols={['key', 'name', 'permissions']}
        rows={roles.map((r) => [
          r.role_key, r.name,
          <span className="dim small">{r.permissions.join(', ')}</span>,
        ])} />
    </div>
  </>;
}

// ---- devices ----
interface DeviceRow {
  id: string; label: string; status: string; created_at: string;
}
function DevicesTab({ storeId }: { storeId: string }) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [label, setLabel] = useState('Entrance iPad');
  const [pairCode, setPairCode] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const refresh = useCallback(async () => {
    const r = await call<{ items: DeviceRow[] }>(
      'GET', `/stores/${storeId}/devices`);
    setDevices(r.items);
  }, [storeId]);
  useEffect(() => { refresh().catch(() => undefined); }, [refresh]);
  const enroll = async () => {
    setErr(null); setPairCode('');
    try {
      const r = await call<{ pairing_code: string }>(
        'POST', `/stores/${storeId}/devices/enrollments`, { label });
      setPairCode(r.pairing_code); await refresh();
    } catch (e) { setErr(e as Error); }
  };
  const revoke = async (d: DeviceRow) => {
    setErr(null);
    try {
      await call('POST', `/stores/${storeId}/devices/${d.id}/revoke`, {});
      await refresh();
    } catch (e) { setErr(e as Error); }
  };
  return <>
    <div className="card">
      <h1>Devices</h1>
      <Table cols={['label', 'status', 'created', '']} rows={devices.map((d) => [
        d.label, <Pill v={d.status} />, fmt(d.created_at),
        d.status === 'ACTIVE'
          ? <button className="danger" onClick={() => revoke(d)}>Revoke</button> : null,
      ])} />
      <Err e={err} />
    </div>
    <div className="card">
      <h2>Pair entrance device</h2>
      <div className="row">
        <input className="grow" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="device label" />
        <button onClick={enroll}>Issue pairing code</button>
      </div>
      {pairCode && <p className="ok">pairing code: <code>{pairCode}</code> (valid 10 min)</p>}
    </div>
  </>;
}

// ---- audit ----
function AuditTab({ storeId }: { storeId: string }) {
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [err, setErr] = useState<Error | null>(null);
  useEffect(() => {
    call<{ items: AuditRow[] }>('GET', `/stores/${storeId}/audit-logs?limit=100`)
      .then((r) => setAudit(r.items)).catch(setErr);
  }, [storeId]);
  return <div className="card"><h2>Audit log</h2>
    <Table cols={['time', 'actor', 'action', 'target']}
      rows={audit.map((a) => [
        fmt(a.created_at), a.actor_display ?? '—', a.action, a.target_type,
      ])} />
    <Err e={err} />
  </div>;
}

// ---- store settings ----
function SettingsTab({ storeId }: { storeId: string }) {
  const [form, setForm] = useState({ name: '', timezone: '', currency: '' });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    setErr(null); setMsg('');
    try {
      const b: Record<string, string> = {};
      if (form.name) b.name = form.name;
      if (form.timezone) b.timezone = form.timezone;
      if (form.currency) b.currency = form.currency;
      const r = await call<{ name: string; version: number }>(
        'PATCH', `/stores/${storeId}`, b);
      setMsg(`saved: ${r.name} (v${r.version})`);
    } catch (e) { setErr(e as Error); }
  };
  return <div className="card">
    <h1>Store settings</h1>
    <div className="grid">
      <label className="f">name</label>
      <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="store name" />
      <label className="f">timezone</label>
      <input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} placeholder="Asia/Tokyo" />
      <label className="f">currency (ISO 4217)</label>
      <input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} placeholder="JPY" maxLength={3} />
      <div className="row"><button onClick={save}>Save</button></div>
      {msg && <p className="ok">{msg}</p>}
      <Err e={err} />
    </div>
  </div>;
}
