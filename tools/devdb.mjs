#!/usr/bin/env node
// devdb.mjs - manage the local embedded PostgreSQL for isolated development.
// Commands: start | stop | status | init | url
// Uses pgserver-bundled binaries discovered via `uv run` (cached in devdb/pginstall.path).
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DBDIR = process.env.DEVDB_DIR || join(ROOT, 'devdb');
const DATA = join(DBDIR, 'data');
const SOCK = join(DBDIR, 'sock');
const PORT = process.env.DEVDB_PORT || '55432';
const PATHFILE = join(DBDIR, 'pginstall.path');

function pginstall() {
  if (process.env.PGINSTALL_DIR) return process.env.PGINSTALL_DIR;
  if (existsSync(PATHFILE)) return readFileSync(PATHFILE, 'utf8').trim();
  const out = execSync(
    `uv run --no-project --python 3.12 --with pgserver python -c "import pgserver,os;print(os.path.join(os.path.dirname(pgserver.__file__),'pginstall'))"`,
    { encoding: 'utf8', shell: '/bin/bash' }
  ).trim();
  mkdirSync(DBDIR, { recursive: true });
  writeFileSync(PATHFILE, out + '\n');
  return out;
}

function bin(name) { return join(pginstall(), 'bin', name); }

function checkExtensions() {
  const ext = join(pginstall(), 'share/postgresql/extension/btree_gist.control');
  if (!existsSync(ext)) {
    console.error('btree_gist not installed in', pginstall());
    console.error('Run: bash tools/build_btree_gist.sh');
    process.exit(3);
  }
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function running() {
  try {
    execFileSync(bin('pg_ctl'), ['-D', DATA, 'status'], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

const url = (db) => `postgresql://postgres@127.0.0.1:${PORT}/${db}`;

const cmd = process.argv[2] || 'status';
checkExtensions();

if (cmd === 'init' || (cmd === 'start' && !existsSync(DATA))) {
  mkdirSync(SOCK, { recursive: true });
  if (!existsSync(DATA)) {
    run(bin('initdb'), ['-D', DATA, '-U', 'postgres', '-E', 'UTF8', '--locale=C', '-A', 'trust']);
  }
}
if (cmd === 'init' || cmd === 'start') {
  if (!running()) {
    run(bin('pg_ctl'), ['-D', DATA, '-l', join(DBDIR, 'postgres.log'), '-w', '-o',
      `-k ${SOCK} -c listen_addresses=127.0.0.1 -p ${PORT} -c unix_socket_permissions=0700`, 'start']);
  }
  // roles + databases (idempotent)
  const psql = (db, sql) => run(bin('psql'), ['-h', '127.0.0.1', '-p', PORT, '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  psql('postgres', `DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='app_migrator') THEN CREATE ROLE app_migrator LOGIN PASSWORD 'dev_migrator'; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='app_runtime') THEN CREATE ROLE app_runtime LOGIN PASSWORD 'dev_runtime'; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='app_readonly') THEN CREATE ROLE app_readonly LOGIN PASSWORD 'dev_readonly'; END IF;
  END $$;`);
  for (const db of ['nightclub_dev', 'nightclub_test']) {
    try { run(bin('createdb'), ['-h', '127.0.0.1', '-p', PORT, '-U', 'postgres', db]); }
    catch { /* exists */ }
  }
  console.log('devdb ready: ' + url('nightclub_dev'));
} else if (cmd === 'stop') {
  if (running()) run(bin('pg_ctl'), ['-D', DATA, '-m', 'fast', 'stop']);
  console.log('stopped');
} else if (cmd === 'status') {
  console.log(running() ? 'running: ' + url('nightclub_dev') : 'not running');
} else if (cmd === 'url') {
  console.log(url(process.argv[3] || 'nightclub_dev'));
} else {
  console.error('usage: devdb.mjs [init|start|stop|status|url [db]]');
  process.exit(2);
}
