// Platform operator console (SaaS operator): tenants, stores, plans,
// subscriptions, invoices, onboarding, operators, usage, deletion requests.
// Requires a personal session whose user is a platform operator.
import { useCallback, useEffect, useState } from 'react';
import { call, uuid } from '../api.js';
import { Err, Pill, Table, Tabs, fmt, yen } from '../ui.js';

const idem = () => uuid();

interface Tenant { id: string; name: string; status: string; created_at: string }
interface Plan {
  id: string; code: string; name: string; monthly_minor: number;
  currency: string; status: string;
}
interface Store { id: string; name: string; status: string; timezone: string }
interface Operator { user_id: string; display_name: string; added_at: string }
interface OnbItem { item_key: string; status: string; note: string | null }
interface Usage { tenant_id: string; metric: string; value: number }
interface DelReq { id: string; status: string; scheduled_at: string; created_at: string }

type Tab = 'tenants' | 'plans' | 'billing' | 'operators' | 'usage';

export function Platform({ me }: { me: { user_id?: string } | null }) {
  const [tab, setTab] = useState<Tab>('tenants');
  const [tenantId, setTenantId] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  if (!me?.user_id) return <p className="dim">Sign in as a platform operator.</p>;
  return <>
    <Err e={err} />
    <Tabs tabs={[['tenants', 'Tenants'], ['plans', 'Plans'], ['billing', 'Billing'], ['operators', 'Operators'], ['usage', 'Usage']]}
      cur={tab} onSel={setTab} />
    {tab === 'tenants' && <Tenants tenantId={tenantId} setTenantId={setTenantId} />}
    {tab === 'plans' && <Plans />}
    {tab === 'billing' && <Billing tenantId={tenantId} setTenantId={setTenantId} />}
    {tab === 'operators' && <Operators me={me} />}
    {tab === 'usage' && <UsageTab />}
  </>;
}

function Tenants({ tenantId, setTenantId }:
  { tenantId: string; setTenantId: (v: string) => void }) {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [onb, setOnb] = useState<OnbItem[]>([]);
  const [dels, setDels] = useState<DelReq[]>([]);
  const [form, setForm] = useState({ name: '', store: '', tz: 'Asia/Tokyo' });
  const [err, setErr] = useState<Error | null>(null);
  const refresh = useCallback(async () => {
    const t = await call<{ items: Tenant[] }>('GET', '/platform/tenants');
    setTenants(t.items);
    if (!tenantId && t.items[0]) setTenantId(t.items[0].id);
  }, [tenantId, setTenantId]);
  useEffect(() => { refresh().catch(setErr); }, [refresh]);
  useEffect(() => {
    if (!tenantId) { setStores([]); setOnb([]); return; }
    call<{ items: Store[] }>('GET', `/platform/tenants/${tenantId}/stores`)
      .then((r) => setStores(r.items)).catch(() => setStores([]));
    call<{ items: OnbItem[] }>('GET', `/platform/tenants/${tenantId}/onboarding`)
      .then((r) => setOnb(r.items)).catch(() => setOnb([]));
  }, [tenantId]);
  const mkTenant = async () => {
    setErr(null);
    try {
      await call('POST', '/platform/tenants', { name: form.name },
        { idem: idem() });
      setForm({ name: '', store: '', tz: 'Asia/Tokyo' }); await refresh();
    } catch (e) { setErr(e as Error); }
  };
  const mkStore = async () => {
    setErr(null);
    try {
      await call('POST', `/platform/tenants/${tenantId}/stores`,
        { name: form.store, timezone: form.tz }, { idem: idem() });
      setForm({ ...form, store: '' });
      const r = await call<{ items: Store[] }>(
        'GET', `/platform/tenants/${tenantId}/stores`);
      setStores(r.items);
    } catch (e) { setErr(e as Error); }
  };
  return <>
    <div className="card">
      <h1>Tenants</h1>
      <Table cols={['name', 'status', 'created']} rows={tenants.map((t) => [
        <a href="#" onClick={(e) => { e.preventDefault(); setTenantId(t.id); }}>
          {t.name}{t.id === tenantId ? ' ●' : ''}</a>,
        <Pill v={t.status} />, fmt(t.created_at),
      ])} />
      <div className="row" style={{ marginTop: 8 }}>
        <input className="grow" value={form.name} placeholder="tenant name"
          onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <button onClick={mkTenant}>Create tenant</button>
      </div>
      <Err e={err} />
    </div>
    <div className="card">
      <h2>Stores (selected tenant)</h2>
      <Table cols={['name', 'status', 'timezone']}
        rows={stores.map((s) => [s.name, <Pill v={s.status} />, s.timezone])} />
      <div className="row" style={{ marginTop: 8 }}>
        <input className="grow" value={form.store} placeholder="store name"
          onChange={(e) => setForm({ ...form, store: e.target.value })} />
        <input style={{ width: 150 }} value={form.tz}
          onChange={(e) => setForm({ ...form, tz: e.target.value })} />
        <button onClick={mkStore}>Add store</button>
      </div>
    </div>
    {onb.length > 0 && <div className="card">
      <h2>Onboarding</h2>
      <Table cols={['item', 'status', 'note']}
        rows={onb.map((o) => [o.item_key, <Pill v={o.status} />, o.note ?? '—'])} />
    </div>}
    {dels.length > 0 && <div className="card">
      <h2>Deletion requests</h2>
      <Table cols={['status', 'scheduled', 'created']}
        rows={dels.map((d) => [d.status, fmt(d.scheduled_at), fmt(d.created_at)])} />
    </div>}
  </>;
}

function Plans() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [form, setForm] = useState({ code: '', name: '', monthly: 9800 });
  const [err, setErr] = useState<Error | null>(null);
  const refresh = useCallback(async () => {
    const r = await call<{ items: Plan[] }>('GET', '/platform/plans');
    setPlans(r.items);
  }, []);
  useEffect(() => { refresh().catch(setErr); }, [refresh]);
  const mk = async () => {
    setErr(null);
    try {
      await call('POST', '/platform/plans',
        { code: form.code, name: form.name, monthly_minor: form.monthly },
        { idem: idem() });
      setForm({ code: '', name: '', monthly: 9800 }); await refresh();
    } catch (e) { setErr(e as Error); }
  };
  return <div className="card">
    <h1>Plans</h1>
    <Table cols={['code', 'name', 'monthly', 'status']}
      rows={plans.map((p) => [
        p.code, p.name, yen(p.monthly_minor, p.currency), <Pill v={p.status} />])} />
    <h3>New plan</h3>
    <div className="row">
      <input style={{ width: 120 }} value={form.code} placeholder="code"
        onChange={(e) => setForm({ ...form, code: e.target.value })} />
      <input className="grow" value={form.name} placeholder="name"
        onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <input style={{ width: 120 }} type="number" value={form.monthly}
        onChange={(e) => setForm({ ...form, monthly: Number(e.target.value) })} />
      <button onClick={mk}>Create</button>
    </div>
    <Err e={err} />
  </div>;
}

interface SubRow { id: string; status: string; version: number }
interface InvRow extends SubRow { amount_minor: number }
function Billing({ tenantId, setTenantId }:
  { tenantId: string; setTenantId: (v: string) => void }) {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [subs, setSubs] = useState<SubRow[]>([]);
  const [invs, setInvs] = useState<InvRow[]>([]);
  const [planId, setPlanId] = useState('');
  const [invForm, setInvForm] = useState({ sub_id: '', amount: 9800 });
  const [err, setErr] = useState<Error | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    Promise.all([
      call<{ items: Tenant[] }>('GET', '/platform/tenants'),
      call<{ items: Plan[] }>('GET', '/platform/plans'),
    ]).then(([t, p]) => {
      setTenants(t.items); setPlans(p.items);
      if (!tenantId && t.items[0]) setTenantId(t.items[0].id);
      setPlanId((v) => v || p.items[0]?.id || '');
    }).catch(setErr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const subscribe = async () => {
    setErr(null); setMsg('');
    try {
      const r = await call<{ subscription_id: string; status: string }>(
        'POST', `/platform/tenants/${tenantId}/subscription`,
        { plan_id: planId }, { idem: idem() });
      const s = { id: r.subscription_id, status: r.status, version: 1 };
      setSubs((v) => [...v, s]);
      setInvForm((f) => ({ ...f, sub_id: s.id }));
      setMsg(`subscription ${s.id.slice(0, 8)} → ${s.status}`);
    } catch (e) { setErr(e as Error); }
  };
  const subTransition = async (s: SubRow, status: string) => {
    setErr(null);
    try {
      const r = await call<{ status: string }>(
        'POST', `/platform/subscriptions/${s.id}/transition`,
        { status, expected_version: s.version }, { idem: idem() });
      setSubs((v) => v.map((x) => x.id === s.id
        ? { ...x, status: r.status, version: x.version + 1 } : x));
    } catch (e) { setErr(e as Error); }
  };
  const issue = async () => {
    setErr(null); setMsg('');
    try {
      const now = Date.now();
      const r = await call<{ invoice_id: string }>(
        'POST', `/platform/tenants/${tenantId}/invoices`, {
          subscription_id: invForm.sub_id,
          period_start: new Date(now).toISOString(),
          period_end: new Date(now + 30 * 86400_000).toISOString(),
          amount_minor: invForm.amount,
          due_at: new Date(now + 14 * 86400_000).toISOString(),
        }, { idem: idem() });
      setInvs((v) => [...v,
        { id: r.invoice_id, status: 'ISSUED', version: 1, amount_minor: invForm.amount }]);
      setMsg(`invoice ${r.invoice_id.slice(0, 8)} issued`);
    } catch (e) { setErr(e as Error); }
  };
  const invTransition = async (i: InvRow, status: string) => {
    setErr(null);
    try {
      const r = await call<{ status: string }>(
        'POST', `/platform/invoices/${i.id}/transition`,
        { status, expected_version: i.version }, { idem: idem() });
      setInvs((v) => v.map((x) => x.id === i.id
        ? { ...x, status: r.status, version: x.version + 1 } : x));
    } catch (e) { setErr(e as Error); }
  };
  return <div className="card">
    <h1>Billing</h1>
    <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
      {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
    <div className="row" style={{ marginTop: 10 }}>
      <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
        {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <button onClick={subscribe}>Set subscription</button>
    </div>
    {msg && <p className="ok">{msg}</p>}
    <Err e={err} />
    <Table cols={['id', 'status', 'actions']}
      rows={subs.map((s) => [
        <code className="small">{s.id.slice(0, 8)}</code>, <Pill v={s.status} />,
        <span className="row">
          {['ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED'].map((st) => (
            <button key={st} className="ghost small"
              onClick={() => subTransition(s, st)}>{st}</button>
          ))}
        </span>,
      ])} />
    <h3>Issue invoice</h3>
    <div className="row">
      <select value={invForm.sub_id}
        onChange={(e) => setInvForm({ ...invForm, sub_id: e.target.value })}>
        <option value="">subscription…</option>
        {subs.map((s) => <option key={s.id} value={s.id}>{s.id.slice(0, 8)}</option>)}
      </select>
      <input style={{ width: 120 }} type="number" min={0} value={invForm.amount}
        onChange={(e) => setInvForm({ ...invForm, amount: Number(e.target.value) })} />
      <button className="ghost" onClick={issue} disabled={!invForm.sub_id}>
        Issue (30d period)</button>
    </div>
    <Table cols={['id', 'amount', 'status', 'actions']}
      rows={invs.map((i) => [
        <code className="small">{i.id.slice(0, 8)}</code>,
        yen(i.amount_minor, 'JPY'), <Pill v={i.status} />,
        <span className="row">
          {['PAID', 'FAILED', 'VOID'].map((st) => (
            <button key={st} className="ghost small"
              onClick={() => invTransition(i, st)}>{st}</button>
          ))}
        </span>,
      ])} />
    <p className="dim small">Subscriptions/invoices created in this session are
      listed above (no list endpoint exists).</p>
  </div>;
}

function Operators({ me }: { me: { user_id?: string } | null }) {
  const [ops, setOps] = useState<Operator[]>([]);
  const [uid, setUid] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const refresh = useCallback(async () => {
    const r = await call<{ items: Operator[] }>('GET', '/platform/operators');
    setOps(r.items);
  }, []);
  useEffect(() => { refresh().catch(setErr); }, [refresh]);
  const add = async () => {
    setErr(null);
    try {
      await call('POST', '/platform/operators', { user_id: uid }, { idem: idem() });
      setUid(''); await refresh();
    } catch (e) { setErr(e as Error); }
  };
  const rm = async (userId: string) => {
    setErr(null);
    try {
      await call('DELETE', `/platform/operators/${userId}`, {}, { idem: idem() });
      await refresh();
    } catch (e) { setErr(e as Error); }
  };
  return <div className="card">
    <h1>Platform operators</h1>
    <Table cols={['user', 'added', '']} rows={ops.map((o) => [
      o.display_name, fmt(o.added_at),
      o.user_id !== me?.user_id
        ? <button className="danger" onClick={() => rm(o.user_id)}>Remove</button>
        : <span className="dim">you</span>,
    ])} />
    <div className="row" style={{ marginTop: 8 }}>
      <input className="grow" value={uid} placeholder="user_id"
        onChange={(e) => setUid(e.target.value)} />
      <button onClick={add}>Add operator</button>
    </div>
    <Err e={err} />
  </div>;
}

function UsageTab() {
  const [rows, setRows] = useState<Usage[]>([]);
  const [err, setErr] = useState<Error | null>(null);
  useEffect(() => {
    call<{ items: Usage[] }>('GET', '/platform/usage')
      .then((r) => setRows(r.items)).catch(setErr);
  }, []);
  return <div className="card">
    <h1>Usage</h1>
    <Table cols={['tenant', 'metric', 'value']}
      rows={rows.map((u) => [u.tenant_id.slice(0, 8), u.metric, u.value])} />
    <Err e={err} />
  </div>;
}
