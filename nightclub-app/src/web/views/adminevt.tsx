// Admin event-operations surfaces: bookings + public booking pages, 2D
// floor map, ticket products/orders/instances, inventory + bottle keeps +
// stocktakes, CRM, finance (orders/refunds/settlements), ops (campaigns,
// forecasts, exports).
import { useCallback, useEffect, useState } from 'react';
import { call, uuid } from '../api.js';
import { Err, Pill, Table, fmt, useEvents, yen } from '../ui.js';

const idem = () => uuid();

// ============================ bookings =====================================
interface Booking {
  id: string; version: number; status: string; party_count: number;
  starts_at: string; ends_at: string; minimum_minor: number;
  deposit_minor: number; currency: string; visit_id: string | null;
  reception_name?: string | null; tables?: string[] | null;
  contact?: { name?: string; phone?: string | null; note?: string | null; source?: string } | null;
}
interface BPage {
  id: string; slug: string; status: string; title: string;
  collect_phone: boolean; max_party: number; version: number;
}
export function Bookings({ storeId }: { storeId: string }) {
  const { eventId, picker } = useEvents(storeId);
  const [items, setItems] = useState<Booking[]>([]);
  const [pages, setPages] = useState<BPage[]>([]);
  const [form, setForm] = useState({ title: '', message: '', max_party: 10, collect_phone: true });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const refresh = useCallback(async () => {
    if (!eventId) { setItems([]); setPages([]); return; }
    const [b, p] = await Promise.all([
      call<{ items: Booking[] }>(
        'GET', `/stores/${storeId}/events/${eventId}/bookings`),
      call<{ items: BPage[] }>(
        'GET', `/stores/${storeId}/events/${eventId}/booking-pages`),
    ]);
    setItems(b.items); setPages(p.items);
  }, [storeId, eventId]);
  useEffect(() => { refresh().catch(setErr); }, [refresh]);

  const decide = async (b: Booking, decision: 'APPROVED' | 'REJECTED') => {
    setErr(null);
    try {
      await call('POST',
        `/stores/${storeId}/events/${eventId}/bookings/${b.id}/decision`,
        { decision, expected_version: b.version }, { idem: idem() });
      await refresh();
    } catch (e) { setErr(e as Error); }
  };
  const mkPage = async () => {
    setErr(null); setMsg('');
    try {
      const r = await call<{ slug: string; url: string }>(
        'POST', `/stores/${storeId}/events/${eventId}/booking-pages`,
        { title: form.title, message: form.message || undefined,
          max_party: form.max_party, collect_phone: form.collect_phone },
        { idem: idem() });
      setMsg(`page live: ${location.origin}${r.url}`);
      setForm({ title: '', message: '', max_party: 10, collect_phone: true });
      await refresh();
    } catch (e) { setErr(e as Error); }
  };
  const toggle = async (p: BPage) => {
    setErr(null);
    try {
      await call('POST',
        `/stores/${storeId}/events/${eventId}/booking-pages/${p.id}/status`,
        { status: p.status === 'OPEN' ? 'CLOSED' : 'OPEN',
          expected_version: p.version }, { idem: idem() });
      await refresh();
    } catch (e) { setErr(e as Error); }
  };

  return <>
    <div className="card">
      <div className="row"><h1 className="grow">Bookings</h1>{picker}</div>
      <Table cols={['party', 'slot', 'status', 'min', 'deposit', 'contact', '']}
        rows={items.map((b) => [
          `×${b.party_count}`,
          `${fmt(b.starts_at)} – ${fmt(b.ends_at)}`,
          <Pill v={b.status} />,
          yen(b.minimum_minor, b.currency), yen(b.deposit_minor, b.currency),
          b.contact?.name
            ? `${b.contact.name}${b.contact.phone ? ` / ${b.contact.phone}` : ''}${b.contact.note ? ` — ${b.contact.note}` : ''}`
            : (b.reception_name ?? '—'),
          b.status === 'APPROVAL_PENDING' || b.status === 'HOLD'
            ? <span className="row">
                <button className="ghost" onClick={() => decide(b, 'APPROVED')}>Approve</button>
                <button className="danger" onClick={() => decide(b, 'REJECTED')}>Reject</button>
              </span> : null,
        ])} />
      <Err e={err} />{msg && <p className="ok">{msg}</p>}
    </div>
    <div className="card">
      <h2>Public booking pages</h2>
      <Table cols={['slug', 'title', 'status', 'max', 'url', '']}
        rows={pages.map((p) => [
          <code>{p.slug}</code>, p.title, <Pill v={p.status} />, p.max_party,
          <a href={`/#/book/${p.slug}`} target="_blank" rel="noreferrer">open</a>,
          <button className="ghost" onClick={() => toggle(p)}>
            {p.status === 'OPEN' ? 'Close' : 'Reopen'}</button>,
        ])} />
      <h3>New page</h3>
      <div className="grid">
        <input value={form.title} placeholder="page title"
          onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <input value={form.message} placeholder="message (optional)"
          onChange={(e) => setForm({ ...form, message: e.target.value })} />
        <div className="row">
          <label className="dim small">max party
            <input style={{ width: 80 }} type="number" min={1} value={form.max_party}
              onChange={(e) => setForm({ ...form, max_party: Number(e.target.value) })} /></label>
          <label className="dim small row" style={{ gap: 4 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={form.collect_phone}
              onChange={(e) => setForm({ ...form, collect_phone: e.target.checked })} />
            collect phone</label>
          <button onClick={mkPage}>Publish page</button>
        </div>
      </div>
    </div>
  </>;
}

// ============================== floor ======================================
interface VTable {
  id: string; table_code: string; zone: string;
  capacity_min: number; capacity_max: number; status: string;
}
interface FMap { id: string; version: number; layout: Record<string, { x: number; y: number; w: number; h: number }> }
export function Floor({ storeId }: { storeId: string }) {
  const [fm, setFm] = useState<FMap | null>(null);
  const [tables, setTables] = useState<VTable[]>([]);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ code: '', zone: '', min: 2, max: 6 });
  const [err, setErr] = useState<Error | null>(null);
  const { eventId, picker } = useEvents(storeId);
  const refresh = useCallback(async () => {
    const r = await call<{ floor_map: FMap | null; tables: VTable[] }>(
      'GET', `/stores/${storeId}/floor`);
    setFm(r.floor_map); setTables(r.tables);
  }, [storeId]);
  useEffect(() => { refresh().catch(setErr); }, [refresh]);
  useEffect(() => {
    if (!eventId) { setAlloc({}); return; }
    // The bookings list exposes allocated table_codes (HELD/CONFIRMED), not
    // table ids — mark any table whose code is currently allocated.
    call<{ items: { tables?: string[] | null }[] }>(
      'GET', `/stores/${storeId}/events/${eventId}/bookings`)
      .then((r) => {
        const m: Record<string, string> = {};
        for (const b of r.items) for (const code of b.tables ?? []) m[code] = 'HELD';
        setAlloc(m);
      }).catch(() => setAlloc({}));
  }, [storeId, eventId]);
  const addTable = async () => {
    setErr(null);
    try {
      await call('POST', `/stores/${storeId}/tables`, {
        table_code: form.code, zone: form.zone,
        capacity_min: form.min, capacity_max: form.max,
      });
      setForm({ code: '', zone: '', min: 2, max: 6 }); await refresh();
    } catch (e) { setErr(e as Error); }
  };
  return <>
    <div className="card">
      <div className="row"><h1 className="grow">Floor (2D)</h1>{picker}</div>
      {fm?.layout ? (
        <div className="floor" style={{ height: 420 }}>
          {tables.map((t) => {
            const r = fm.layout[t.id];
            if (!r) return null;
            const st = alloc[t.table_code];
            return <div key={t.id}
              className={`tbl ${st ?? ''}`}
              style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
              title={`${t.table_code} (${t.capacity_min}-${t.capacity_max}) ${st ?? 'FREE'}`}>
              {t.table_code}{st ? ` ${st}` : ''}
            </div>;
          })}
        </div>
      ) : <p className="dim">no published floor map — publish layout via API (floor-maps)</p>}
    </div>
    <div className="card">
      <h2>Tables</h2>
      <Table cols={['code', 'zone', 'capacity', 'status']}
        rows={tables.map((t) => [
          t.table_code, t.zone, `${t.capacity_min}–${t.capacity_max}`, t.status,
        ])} />
      <h3>Add table</h3>
      <div className="row">
        <input style={{ width: 110 }} value={form.code} placeholder="code"
          onChange={(e) => setForm({ ...form, code: e.target.value })} />
        <input style={{ width: 110 }} value={form.zone} placeholder="zone"
          onChange={(e) => setForm({ ...form, zone: e.target.value })} />
        <input style={{ width: 80 }} type="number" min={1} value={form.min}
          onChange={(e) => setForm({ ...form, min: Number(e.target.value) })} />
        <input style={{ width: 80 }} type="number" min={1} value={form.max}
          onChange={(e) => setForm({ ...form, max: Number(e.target.value) })} />
        <button onClick={addTable}>Add</button>
      </div>
      <Err e={err} />
    </div>
  </>;
}

// ============================= tickets =====================================
interface TProduct {
  id: string; code: string; name: string; price_minor: number;
  currency: string; status: string; sales_from: string; sales_to: string;
  quantity_limit: number | null; per_order_limit: number;
  sold: number; version: number;
}
interface TOrder {
  id: string; status: string; quantity: number; amount_minor: number;
  currency: string; product_code: string; product_name: string;
  buyer_name: string | null; redeemed: number; created_at: string;
}
interface TInst {
  id: string; status: string; order_id: string; product_code: string;
  buyer_name: string | null; redeemed_at: string | null; created_at: string;
}
export function Tickets({ storeId }: { storeId: string }) {
  const { eventId, picker } = useEvents(storeId);
  const [products, setProducts] = useState<TProduct[]>([]);
  const [orders, setOrders] = useState<TOrder[]>([]);
  const [insts, setInsts] = useState<TInst[]>([]);
  const [form, setForm] = useState({
    code: '', name: '', price: 3000, from: '', to: '', limit: '', per_order: 4,
  });
  const [err, setErr] = useState<Error | null>(null);
  const refresh = useCallback(async () => {
    if (!eventId) { setProducts([]); setOrders([]); setInsts([]); return; }
    const [p, o, t] = await Promise.all([
      call<{ items: TProduct[] }>(
        'GET', `/stores/${storeId}/events/${eventId}/ticket-products`),
      call<{ items: TOrder[] }>(
        'GET', `/stores/${storeId}/events/${eventId}/ticket-orders`),
      call<{ items: TInst[] }>(
        'GET', `/stores/${storeId}/events/${eventId}/tickets`),
    ]);
    setProducts(p.items); setOrders(o.items); setInsts(t.items);
  }, [storeId, eventId]);
  useEffect(() => { refresh().catch(setErr); }, [refresh]);
  const mkProduct = async () => {
    setErr(null);
    try {
      await call('POST', `/stores/${storeId}/events/${eventId}/ticket-products`, {
        code: form.code, name: form.name, price_minor: form.price,
        sales_from: new Date(form.from).toISOString(),
        sales_to: new Date(form.to).toISOString(),
        quantity_limit: form.limit ? Number(form.limit) : null,
        per_order_limit: form.per_order,
      }, { idem: idem() });
      setForm({ code: '', name: '', price: 3000, from: '', to: '', limit: '', per_order: 4 });
      await refresh();
    } catch (e) { setErr(e as Error); }
  };
  const act = async (path: string, id: string) => {
    setErr(null);
    try {
      await call('POST', `/stores/${storeId}/events/${eventId}/tickets/${id}/${path}`,
        {}, { idem: idem() });
      await refresh();
    } catch (e) { setErr(e as Error); }
  };
  return <>
    <div className="card">
      <div className="row"><h1 className="grow">Ticket products</h1>{picker}</div>
      <Table cols={['code', 'name', 'price', 'window', 'sold/limit', 'status']}
        rows={products.map((p) => [
          p.code, p.name, yen(p.price_minor, p.currency),
          `${fmt(p.sales_from)}→${fmt(p.sales_to)}`,
          `${p.sold}/${p.quantity_limit ?? '∞'}`, <Pill v={p.status} />,
        ])} />
      <h3>New product</h3>
      <div className="grid">
        <div className="row">
          <input className="grow" value={form.code} placeholder="code"
            onChange={(e) => setForm({ ...form, code: e.target.value })} />
          <input className="grow" value={form.name} placeholder="name"
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input style={{ width: 110 }} type="number" min={0} value={form.price}
            onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} />
        </div>
        <div className="row">
          <label className="f">sales from</label>
          <input type="datetime-local" value={form.from}
            onChange={(e) => setForm({ ...form, from: e.target.value })} />
          <label className="f">to</label>
          <input type="datetime-local" value={form.to}
            onChange={(e) => setForm({ ...form, to: e.target.value })} />
        </div>
        <div className="row">
          <input style={{ width: 130 }} value={form.limit} placeholder="qty limit (∞)"
            onChange={(e) => setForm({ ...form, limit: e.target.value })} />
          <input style={{ width: 130 }} type="number" min={1} value={form.per_order}
            onChange={(e) => setForm({ ...form, per_order: Number(e.target.value) })} />
          <button onClick={mkProduct}>Create</button>
        </div>
      </div>
      <Err e={err} />
    </div>
    <div className="card">
      <h2>Orders</h2>
      <Table cols={['id', 'product', 'buyer', 'qty', 'amount', 'redeemed', 'status', 'created']}
        rows={orders.map((o) => [
          <code className="small">{o.id.slice(0, 8)}</code>, o.product_code,
          o.buyer_name ?? '—', o.quantity,
          yen(o.amount_minor, o.currency), `${o.redeemed}/${o.quantity}`,
          <Pill v={o.status} />, fmt(o.created_at),
        ])} />
    </div>
    <div className="card">
      <h2>Ticket instances</h2>
      <Table cols={['id', 'product', 'buyer', 'status', 'created', '']}
        rows={insts.map((t) => [
          <code className="small">{t.id.slice(0, 8)}</code>,
          t.product_code, t.buyer_name ?? '—',
          <Pill v={t.status} />, fmt(t.created_at),
          t.status === 'ISSUED' && <span className="row">
            <button className="ghost" onClick={() => act('reissue', t.id)}>Reissue</button>
            <button className="danger" onClick={() => act('revoke', t.id)}>Revoke</button>
          </span>,
        ])} />
    </div>
  </>;
}

// ============================ inventory ====================================
interface Product {
  id: string; sku: string; name: string; kind: string;
  price_minor: number; currency: string; status: string;
  stock_on_hand?: number;
}
interface Keep {
  id: string; label: string; status: string; expires_at: string;
  customer_name: string; product_name: string; remaining_percent: number;
  version: number;
}
interface Stocktake {
  id: string; status: string; note: string | null; version: number;
  created_at: string; lines: number; counted: number;
}
export function Inventory({ storeId }: { storeId: string }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [keeps, setKeeps] = useState<Keep[]>([]);
  const [takes, setTakes] = useState<Stocktake[]>([]);
  const [pf, setPf] = useState({ sku: '', name: '', kind: 'ITEM', price: 1000, tracked: true, init: 0 });
  const [mv, setMv] = useState<Record<string, string>>({});
  const [err, setErr] = useState<Error | null>(null);
  const refresh = useCallback(async () => {
    const [p, k, s] = await Promise.all([
      call<{ items: Product[] }>('GET', `/stores/${storeId}/products`),
      call<{ items: Keep[] }>('GET', `/stores/${storeId}/bottle-keeps`),
      call<{ items: Stocktake[] }>('GET', `/stores/${storeId}/stocktakes`),
    ]);
    setProducts(p.items); setKeeps(k.items); setTakes(s.items);
  }, [storeId]);
  useEffect(() => { refresh().catch(setErr); }, [refresh]);
  const mkProduct = async () => {
    setErr(null);
    try {
      await call('POST', `/stores/${storeId}/products`, {
        sku: pf.sku, name: pf.name, kind: pf.kind, price_minor: pf.price,
        stock_tracked: pf.tracked, initial_stock: pf.init,
      }, { idem: idem() });
      setPf({ sku: '', name: '', kind: 'ITEM', price: 1000, tracked: true, init: 0 });
      await refresh();
    } catch (e) { setErr(e as Error); }
  };
  const move = async (p: Product, kind: 'IN' | 'OUT' | 'ADJUST') => {
    setErr(null);
    const q = Number(mv[p.id]);
    if (!q) { setErr(new Error('enter quantity')); return; }
    try {
      await call('POST', `/stores/${storeId}/products/${p.id}/stock`,
        { kind, quantity: kind === 'OUT' ? -Math.abs(q) : q, ref: 'ui' },
        { idem: idem() });
      setMv((m) => ({ ...m, [p.id]: '' })); await refresh();
    } catch (e) { setErr(e as Error); }
  };
  const openTake = async () => {
    setErr(null);
    try {
      await call('POST', `/stores/${storeId}/stocktakes`, {}, { idem: idem() });
      await refresh();
    } catch (e) { setErr(e as Error); }
  };
  const closeTake = async (s: Stocktake) => {
    setErr(null);
    try {
      await call('POST', `/stores/${storeId}/stocktakes/${s.id}/transition`,
        { expected_version: s.version, status: 'CLOSED', apply_adjustments: true },
        { idem: idem() });
      await refresh();
    } catch (e) { setErr(e as Error); }
  };
  return <>
    <div className="card">
      <h1>Products / stock</h1>
      <Table cols={['sku', 'name', 'kind', 'price', 'on hand', 'status', 'stock move']}
        rows={products.map((p) => [
          p.sku, p.name, p.kind, yen(p.price_minor, p.currency),
          p.stock_on_hand ?? '—',
          <Pill v={p.status} />,
          <span className="row">
            <input style={{ width: 70 }} value={mv[p.id] ?? ''} placeholder="qty"
              onChange={(e) => setMv((m) => ({ ...m, [p.id]: e.target.value }))} />
            <button className="ghost" onClick={() => move(p, 'IN')}>in</button>
            <button className="ghost" onClick={() => move(p, 'OUT')}>out</button>
          </span>,
        ])} />
      <h3>New product</h3>
      <div className="row">
        <input style={{ width: 110 }} value={pf.sku} placeholder="sku"
          onChange={(e) => setPf({ ...pf, sku: e.target.value })} />
        <input className="grow" value={pf.name} placeholder="name"
          onChange={(e) => setPf({ ...pf, name: e.target.value })} />
        <select style={{ width: 110 }} value={pf.kind}
          onChange={(e) => setPf({ ...pf, kind: e.target.value })}>
          <option value="ITEM">Item</option>
          <option value="BOTTLE">Bottle</option>
          <option value="PACKAGE">Package</option>
        </select>
        <input style={{ width: 100 }} type="number" min={0} value={pf.price}
          onChange={(e) => setPf({ ...pf, price: Number(e.target.value) })} />
        <input style={{ width: 80 }} type="number" min={0} value={pf.init}
          onChange={(e) => setPf({ ...pf, init: Number(e.target.value) })} />
        <button onClick={mkProduct}>Create</button>
      </div>
      <Err e={err} />
    </div>
    <div className="card">
      <h2>Bottle keeps</h2>
      <Table cols={['label', 'customer', 'product', 'left', 'status', 'expires']}
        rows={keeps.map((k) => [
          k.label, k.customer_name, k.product_name,
          `${k.remaining_percent}%`, <Pill v={k.status} />, fmt(k.expires_at),
        ])} />
    </div>
    <div className="card">
      <div className="row"><h2 className="grow">Stocktakes</h2>
        <button className="ghost" onClick={openTake}>Open stocktake</button></div>
      <Table cols={['id', 'status', 'counted', 'note', 'started', '']}
        rows={takes.map((s) => [
          <code className="small">{s.id.slice(0, 8)}</code>, <Pill v={s.status} />,
          `${s.counted}/${s.lines}`,
          s.note ?? '—', fmt(s.created_at),
          s.status === 'OPEN'
            ? <button className="ghost" onClick={() => closeTake(s)}>Close + apply</button> : null,
        ])} />
    </div>
  </>;
}

// =============================== CRM =======================================
interface CustRow {
  id: string; display_name: string; regular_status: string;
  masked_hint: string | null; version?: number;
}
interface CustDetail {
  customer: CustRow & { created_at?: string };
  aliases?: string[];
  tags?: { tag_id: string; tag_key: string }[];
  recent_visits?: { id: string; reception_name: string; status: string; created_at: string }[];
  open_bottle_keeps?: { id: string; label: string; remaining_percent: number; expires_at: string; status: string }[];
}
interface Tag { id: string; tag_key: string; description: string | null }
export function Crm({ storeId }: { storeId: string }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<CustRow[]>([]);
  const [detail, setDetail] = useState<CustDetail | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [newCust, setNewCust] = useState({ name: '', reading: '' });
  const [newTag, setNewTag] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const loadTags = useCallback(async () => {
    const r = await call<{ items: Tag[] }>('GET', `/stores/${storeId}/customer-tags`);
    setTags(r.items);
  }, [storeId]);
  useEffect(() => { loadTags().catch(() => undefined); }, [loadTags]);
  const search = async () => {
    setErr(null);
    try {
      const r = await call<{ items: CustRow[] }>(
        'GET', `/stores/${storeId}/customers?q=${encodeURIComponent(q)}`);
      setRows(r.items);
    } catch (e) { setErr(e as Error); }
  };
  const open = async (id: string) => {
    setErr(null);
    try {
      const d = await call<CustDetail>('GET', `/stores/${storeId}/customers/${id}`);
      setDetail(d);
    } catch (e) { setErr(e as Error); }
  };
  const mkCustomer = async () => {
    setErr(null);
    try {
      await call('POST', `/stores/${storeId}/customers`, {
        display_name: newCust.name, reading: newCust.reading || undefined,
      });
      setNewCust({ name: '', reading: '' }); await search();
    } catch (e) { setErr(e as Error); }
  };
  const mkTag = async () => {
    setErr(null);
    try {
      await call('POST', `/stores/${storeId}/customer-tags`,
        { tag_key: newTag }, { idem: idem() });
      setNewTag(''); await loadTags();
    } catch (e) { setErr(e as Error); }
  };
  const tag = async (custId: string, tagId: string, on: boolean) => {
    setErr(null);
    try {
      if (on) await call('PUT', `/stores/${storeId}/customers/${custId}/tags/${tagId}`, {});
      else await call('DELETE', `/stores/${storeId}/customers/${custId}/tags/${tagId}`, {});
      await open(custId);
    } catch (e) { setErr(e as Error); }
  };
  return <>
    <div className="card">
      <h1>Customers</h1>
      <div className="row">
        <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="name / kana search" />
        <button className="ghost" onClick={search}>Search</button>
      </div>
      <Table cols={['name', 'status', 'hint', '']}
        rows={rows.map((c) => [
          c.display_name, <Pill v={c.regular_status} />, c.masked_hint ?? '—',
          <button className="ghost" onClick={() => open(c.id)}>detail</button>,
        ])} />
      <h3>New customer</h3>
      <div className="row">
        <input className="grow" value={newCust.name} placeholder="display name"
          onChange={(e) => setNewCust({ ...newCust, name: e.target.value })} />
        <input className="grow" value={newCust.reading} placeholder="reading (kana)"
          onChange={(e) => setNewCust({ ...newCust, reading: e.target.value })} />
        <button onClick={mkCustomer}>Create</button>
      </div>
      <Err e={err} />
    </div>
    {detail && <div className="card">
      <h2>{detail.customer.display_name}</h2>
      <p className="dim">created {fmt(detail.customer.created_at)} ·
        aliases: {(detail.aliases ?? []).join(', ') || '—'}</p>
      <h3>Tags</h3>
      <div className="row">
        {tags.map((t) => {
          const on = (detail.tags ?? []).some((x) => x.tag_id === t.id);
          return <button key={t.id} className={on ? '' : 'ghost'}
            onClick={() => tag(detail.customer.id, t.id, !on)}>{t.tag_key}</button>;
        })}
        {!tags.length && <span className="dim">no tags defined</span>}
      </div>
      {(detail.recent_visits?.length ?? 0) > 0 && <>
        <h3>Recent visits</h3>
        <Table cols={['name', 'status', 'created']}
          rows={(detail.recent_visits ?? []).map((v) => [
            v.reception_name, <Pill v={v.status} />, fmt(v.created_at),
          ])} />
      </>}
      {(detail.open_bottle_keeps?.length ?? 0) > 0 && <>
        <h3>Open bottle keeps</h3>
        <Table cols={['label', 'left', 'expires']}
          rows={(detail.open_bottle_keeps ?? []).map((k) => [
            k.label, `${k.remaining_percent}%`, fmt(k.expires_at),
          ])} />
      </>}
    </div>}
    <div className="card">
      <h2>Tag definitions</h2>
      <div className="row">
        <input className="grow" value={newTag} placeholder="new tag key (e.g. vip, birthday)"
          onChange={(e) => setNewTag(e.target.value)} />
        <button className="ghost" onClick={mkTag}>Add tag</button>
      </div>
      <p className="dim">{tags.map((t) => t.tag_key).join(', ') || 'none'}</p>
    </div>
  </>;
}

// ============================= finance =====================================
interface Order {
  id: string; kind: string; status: string; gross_minor: number;
  net_minor?: number; currency: string; created_at: string;
}
interface Settle { id: string; version: number; status: string; created_at: string }
export function Finance({ storeId }: { storeId: string }) {
  const { eventId, picker } = useEvents(storeId);
  const [orders, setOrders] = useState<Order[]>([]);
  const [settles, setSettles] = useState<Settle[]>([]);
  const [err, setErr] = useState<Error | null>(null);
  const [msg, setMsg] = useState('');
  const refresh = useCallback(async () => {
    if (!eventId) { setOrders([]); return; }
    const o = await call<{ items: Order[] }>(
      'GET', `/stores/${storeId}/events/${eventId}/orders?limit=100`);
    setOrders(o.items);
  }, [storeId, eventId]);
  useEffect(() => { refresh().catch(setErr); }, [refresh]);
  const mkSettle = async () => {
    setErr(null); setMsg('');
    try {
      const r = await call<{ settlement_id: string; version: number }>(
        'POST', `/stores/${storeId}/events/${eventId}/settlements`, {},
        { idem: idem() });
      setMsg(`settlement ${r.settlement_id.slice(0, 8)} drafted`);
    } catch (e) { setErr(e as Error); }
  };
  return <>
    <div className="card">
      <div className="row"><h1 className="grow">Orders</h1>{picker}</div>
      <Table cols={['id', 'kind', 'gross', 'status', 'created']}
        rows={orders.map((o) => [
          <code className="small">{o.id.slice(0, 8)}</code>, o.kind,
          yen(o.gross_minor, o.currency), <Pill v={o.status} />, fmt(o.created_at),
        ])} />
      <Err e={err} />
    </div>
    <div className="card">
      <div className="row"><h2 className="grow">Settlements</h2>
        <button className="ghost" onClick={mkSettle}>Build settlement</button></div>
      <Table cols={['id', 'status', 'created']}
        rows={settles.map((s) => [
          <code className="small">{s.id.slice(0, 8)}</code>,
          <Pill v={s.status} />, fmt(s.created_at),
        ])} />
      {msg && <p className="ok">{msg}</p>}
    </div>
  </>;
}

// =============================== ops =======================================
interface Campaign {
  id: string; name: string; channel: string; status: string;
  scheduled_at: string | null; version: number;
}
interface Forecast {
  id: string; event_id: string | null; horizon_days: number;
  metrics: Record<string, unknown>; created_at: string;
}
interface ExportJob {
  id: string; report_kind: string; status: string; object_key: string | null;
  created_at: string;
}
export function Ops({ storeId }: { storeId: string }) {
  const [camps, setCamps] = useState<Campaign[]>([]);
  const [fcs, setFcs] = useState<Forecast[]>([]);
  const [exports_, setExports] = useState<ExportJob[]>([]);
  const [camp, setCamp] = useState({ name: '', channel: 'IN_APP', body: '' });
  const [err, setErr] = useState<Error | null>(null);
  const refresh = useCallback(async () => {
    const [c, f, x] = await Promise.all([
      call<{ items: Campaign[] }>('GET', `/stores/${storeId}/campaigns`),
      call<{ items: Forecast[] }>('GET', `/stores/${storeId}/forecasts`),
      call<{ items: ExportJob[] }>('GET', `/stores/${storeId}/exports`),
    ]);
    setCamps(c.items); setFcs(f.items); setExports(x.items);
  }, [storeId]);
  useEffect(() => { refresh().catch(setErr); }, [refresh]);
  const mkCamp = async () => {
    setErr(null);
    try {
      await call('POST', `/stores/${storeId}/campaigns`, {
        name: camp.name, channel: camp.channel, body: camp.body,
      }, { idem: idem() });
      setCamp({ name: '', channel: 'IN_APP', body: '' }); await refresh();
    } catch (e) { setErr(e as Error); }
  };
  const campAct = async (c: Campaign, act: 'dispatch' | 'cancel') => {
    setErr(null);
    try {
      await call('POST', `/stores/${storeId}/campaigns/${c.id}/${act}`,
        act === 'cancel' ? { expected_version: c.version } : {},
        { idem: idem() });
      await refresh();
    } catch (e) { setErr(e as Error); }
  };
  const mkExport = async (kind: string) => {
    setErr(null);
    try {
      await call('POST', `/stores/${storeId}/exports`,
        { report_kind: kind, format: 'CSV' }, { idem: idem() });
      await refresh();
    } catch (e) { setErr(e as Error); }
  };
  const runForecast = async () => {
    setErr(null);
    try {
      await call('POST', `/stores/${storeId}/forecasts`,
        { horizon_days: 30 }, { idem: idem() });
      await refresh();
    } catch (e) { setErr(e as Error); }
  };
  return <>
    <div className="card">
      <h1>Campaigns</h1>
      <Table cols={['name', 'channel', 'status', 'scheduled', '']}
        rows={camps.map((c) => [
          c.name, c.channel, <Pill v={c.status} />, fmt(c.scheduled_at),
          (c.status === 'DRAFT' || c.status === 'SCHEDULED') && <span className="row">
            <button className="ghost" onClick={() => campAct(c, 'dispatch')}>Dispatch</button>
            <button className="danger" onClick={() => campAct(c, 'cancel')}>Cancel</button>
          </span>,
        ])} />
      <h3>New campaign</h3>
      <div className="grid">
        <div className="row">
          <input className="grow" value={camp.name} placeholder="name"
            onChange={(e) => setCamp({ ...camp, name: e.target.value })} />
          <select style={{ width: 130 }} value={camp.channel}
            onChange={(e) => setCamp({ ...camp, channel: e.target.value })}>
            <option value="IN_APP">In-app</option>
            <option value="EMAIL">Email</option>
            <option value="LINE">LINE</option>
            <option value="PUSH">Push</option>
          </select>
        </div>
        <input value={camp.body} placeholder="message body"
          onChange={(e) => setCamp({ ...camp, body: e.target.value })} />
        <div className="row"><button onClick={mkCamp}>Create</button></div>
      </div>
      <Err e={err} />
    </div>
    <div className="card">
      <div className="row"><h2 className="grow">Demand forecasts</h2>
        <button className="ghost" onClick={runForecast}>Run forecast</button></div>
      <Table cols={['id', 'horizon', 'created', 'result']}
        rows={fcs.map((f) => [
          <code className="small">{f.id.slice(0, 8)}</code>,
          `${f.horizon_days}d`, fmt(f.created_at),
          <code className="small">{JSON.stringify(f.metrics).slice(0, 80)}</code>,
        ])} />
    </div>
    <div className="card">
      <h2>Exports</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        {['visits', 'payments', 'audit'].map((k) => (
          <button key={k} className="ghost" onClick={() => mkExport(k)}>Export {k}</button>
        ))}
      </div>
      <Table cols={['kind', 'status', 'file', 'created']}
        rows={exports_.map((x) => [
          x.report_kind, <Pill v={x.status} />,
          x.object_key
            ? <a href={`/api/stores/${storeId}/exports/${x.id}/download`}>download</a>
            : '—',
          fmt(x.created_at),
        ])} />
    </div>
  </>;
}
