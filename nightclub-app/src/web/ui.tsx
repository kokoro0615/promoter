// Shared view primitives: error display, tab bar, pills, generic table.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiError, call } from './api.js';

export interface Membership {
  membership_id: string; tenant_id: string; store_id: string;
  display_name: string; status: string; store_name: string;
  permissions: string[] | null;
}
export interface Me {
  user_id?: string; display_name?: string | null;
  memberships?: Membership[]; device?: boolean;
}
export interface EventRow {
  id: string; name: string; status: string;
  opens_at?: string; closes_at?: string; version?: number;
}

export function Err({ e }: { e: Error | null }) {
  return e ? <p className="err">{(e as ApiError).code}: {e.message}</p> : null;
}

export function Pill({ v }: { v: string }) {
  return <span className={`pill ${v}`}>{v}</span>;
}

export function Tabs<T extends string>({ tabs, cur, onSel }:
  { tabs: [T, string][]; cur: T; onSel: (t: T) => void }) {
  return <div className="tabs">
    {tabs.map(([k, label]) => (
      <button key={k} className={cur === k ? 'active' : ''}
        onClick={() => onSel(k)}>{label}</button>
    ))}
  </div>;
}

export function Table({ cols, rows, empty = 'none' }: {
  cols: string[]; rows: ReactNode[][]; empty?: string;
}) {
  return <table>
    <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
    <tbody>
      {rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}
      {!rows.length && <tr><td colSpan={cols.length} className="dim">{empty}</td></tr>}
    </tbody>
  </table>;
}

// Event picker shared by all store-scoped views.
export function useEvents(storeId: string | undefined) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [eventId, setEventId] = useState('');
  useEffect(() => {
    if (!storeId) return;
    call<{ items: EventRow[] }>('GET', `/stores/${storeId}/events`)
      .then((r) => {
        setEvents(r.items);
        setEventId((cur) => cur || r.items[0]?.id || '');
      }).catch(() => undefined);
  }, [storeId]);
  const picker = <select value={eventId} onChange={(e) => setEventId(e.target.value)}>
    {!events.length && <option value="">no events</option>}
    {events.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.status})</option>)}
  </select>;
  return { events, eventId, setEventId, picker };
}

// Reusable command runner for buttons (error capture + busy flag).
export function useCmd() {
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setErr(null); setBusy(true);
    try { await fn(); } catch (e) { setErr(e as Error); }
    finally { setBusy(false); }
  }, []);
  return { err, busy, run, setErr };
}

export const fmt = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '—';
export const yen = (n?: number | null, cur = 'JPY') =>
  n == null ? '—' : `${cur === 'JPY' ? '¥' : `${cur} `}${Number(n).toLocaleString()}`;
