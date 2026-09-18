#!/usr/bin/env node
// model_summary.mjs - regenerate docs/execution/model_summary.txt from the
// live `nightclub` schema. Column `*` = NOT NULL. Scope tags:
//   global = no tenant_id, tenant = tenant_id only,
//   store = store_id but no event_id, event = has event_id.
// Usage: node tools/model_summary.mjs [database-url]
import pg from 'pg';

const url = process.argv[2] || process.env.MODEL_DATABASE_URL
  || 'postgresql://postgres@127.0.0.1:55432/nightclub_dev';
const client = new pg.Client({ connectionString: url });
await client.connect();

const SHORT = {
  uuid: 'uuid', text: 'text', integer: 'integer', bigint: 'bigint',
  smallint: 'smallint', boolean: 'boolean', jsonb: 'jsonb', json: 'json',
  'timestamp with time zone': 'timestamptz',
  'timestamp without time zone': 'timestamp', date: 'date',
  numeric: 'numeric', inet: 'inet', 'character varying': 'text',
};

const tables = await client.query(`
  SELECT c.oid, c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'nightclub' AND c.relkind = 'r'
  ORDER BY c.oid`);

// node-postgres may return attname[] as a '{a,b}' string depending on the
// resolved array type — normalise to a JS array either way.
const arr = (v) => Array.isArray(v) ? v
  : String(v).replace(/^\{|\}$/g, '').split(',').filter(Boolean);

const cols = await client.query(`
  SELECT table_name, column_name, data_type, is_nullable, ordinal_position,
         character_maximum_length, udt_name
  FROM information_schema.columns
  WHERE table_schema = 'nightclub' ORDER BY table_name, ordinal_position`);
const byTable = new Map();
for (const r of cols.rows) {
  if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
  byTable.get(r.table_name).push(r);
}

const uqs = await client.query(`
  SELECT con.conrelid::regclass::text AS tbl,
         array_agg(a.attname ORDER BY x.n) AS cols, con.oid
  FROM pg_constraint con
  JOIN pg_namespace n ON n.oid = con.connamespace
  JOIN unnest(con.conkey) WITH ORDINALITY x(attnum, n) ON true
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum
  WHERE n.nspname = 'nightclub' AND con.contype IN ('u', 'p')
  GROUP BY con.conrelid, con.oid ORDER BY con.oid`);
const uqByTable = new Map();
for (const r of uqs.rows) {
  const t = r.tbl.replace(/^nightclub\./, '');
  const cols = arr(r.cols);
  if (cols.length === 1 && cols[0] === 'id') continue;
  if (!uqByTable.has(t)) uqByTable.set(t, []);
  uqByTable.get(t).push(cols);
}

const fks = await client.query(`
  SELECT con.conrelid::regclass::text AS tbl,
         con.confrelid::regclass::text AS ref,
         (SELECT array_agg(a.attname ORDER BY x.n)
          FROM unnest(con.conkey) WITH ORDINALITY x(attnum, n)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS local_cols,
         (SELECT array_agg(a.attname ORDER BY x.n)
          FROM unnest(con.confkey) WITH ORDINALITY x(attnum, n)
          JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = x.attnum) AS ref_cols,
         con.oid
  FROM pg_constraint con
  JOIN pg_namespace n ON n.oid = con.connamespace
  WHERE n.nspname = 'nightclub' AND con.contype = 'f'
  ORDER BY con.oid`);
const fkByTable = new Map();
for (const r of fks.rows) {
  const t = r.tbl.replace(/^nightclub\./, '');
  if (!fkByTable.has(t)) fkByTable.set(t, []);
  fkByTable.get(t).push(r);
}

const out = [];
for (const t of tables.rows) {
  const name = t.relname;
  const tableCols = byTable.get(name) || [];
  const names = new Set(tableCols.map((c) => c.column_name));
  const scope = !names.has('tenant_id') ? 'global'
    : !names.has('store_id') ? 'tenant'
    : !names.has('event_id') ? 'store' : 'event';
  out.push(`== ${name} [${scope}]`);
  out.push('  ' + tableCols.map((c) =>
    `${c.column_name}:${c.data_type === 'character' ? `char(${c.character_maximum_length})` : c.data_type === 'ARRAY' ? `${c.udt_name.replace(/^_/, '')}[]` : (SHORT[c.data_type] || c.data_type)}${c.is_nullable === 'NO' ? '*' : ''}`,
  ).join(', '));
  const uq = uqByTable.get(name);
  if (uq?.length) out.push(`  UQ: [${uq.map((u) => `[${u.map((c) => `'${c}'`).join(', ')}]`).join(', ')}]`);
  for (const f of fkByTable.get(name) || []) {
    const ref = f.ref.replace(/^nightclub\./, '');
    out.push(`  FK [${arr(f.local_cols).map((c) => `'${c}'`).join(', ')}] -> ${ref}([${arr(f.ref_cols).map((c) => `'${c}'`).join(', ')}])`);
  }
}

console.log(out.join('\n'));
await client.end();
