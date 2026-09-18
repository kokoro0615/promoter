#!/usr/bin/env node
// Backup/restore for the embedded devdb. Uses the bundled pg_dump/pg_restore.
//   node tools/backup.mjs backup  [outfile.dump]   -> devdb/backups/<ts>.dump
//   node tools/backup.mjs restore <file.dump>      -> restores into DATABASE_URL db
// Restore drops/recreates the public+nightclub schemas (destructive; dev only).
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DBDIR = process.env.DEVDB_DIR || join(ROOT, 'devdb');
const PATHFILE = join(DBDIR, 'pginstall.path');
const PORT = process.env.DEVDB_PORT || '55432';
const DB = process.env.DB_NAME || 'nightclub_dev';

function pginstall() {
  if (process.env.PGINSTALL_DIR) return process.env.PGINSTALL_DIR;
  if (existsSync(PATHFILE)) return readFileSync(PATHFILE, 'utf8').trim();
  const out = execSync(
    `uv run --no-project --python 3.12 --with pgserver python -c "import pgserver,os;print(os.path.join(os.path.dirname(pgserver.__file__),'pginstall'))"`,
    { encoding: 'utf8', shell: '/bin/bash' }).trim();
  mkdirSync(DBDIR, { recursive: true });
  writeFileSync(PATHFILE, out + '\n');
  return out;
}
const bin = (n) => join(pginstall(), 'bin', n);
const conn = ['-h', '127.0.0.1', '-p', PORT, '-U', 'postgres', '-d', DB];

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'backup') {
  const dir = join(DBDIR, 'backups');
  mkdirSync(dir, { recursive: true });
  const out = arg || join(dir,
    `nc-${DB}-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
  execFileSync(bin('pg_dump'),
    [...conn, '-Fc', '-n', 'nightclub', '-n', 'public', '-f', out],
    { stdio: 'inherit' });
  console.log(`backup -> ${out}`);
} else if (cmd === 'restore') {
  if (!arg || !existsSync(arg)) {
    console.error('usage: backup.mjs restore <file.dump>');
    process.exit(2);
  }
  execFileSync(bin('psql'), [...conn, '-v', 'ON_ERROR_STOP=1', '-c',
    `DROP SCHEMA IF EXISTS nightclub CASCADE; DROP SCHEMA IF EXISTS public CASCADE;
     CREATE SCHEMA public;
     CREATE EXTENSION IF NOT EXISTS btree_gist;
     CREATE EXTENSION IF NOT EXISTS pg_trgm;`],
    { stdio: 'inherit' });
  // keep privileges: the dump carries GRANTs for app_runtime/app_readonly.
  // pg_restore exits 1 on non-fatal errors (e.g. "schema public exists").
  try {
    execFileSync(bin('pg_restore'), [...conn, '--no-owner', arg],
      { stdio: 'inherit' });
  } catch (e) {
    if (e.status !== 1) throw e;
    console.warn('pg_restore completed with warnings (exit 1)');
  }
  console.log(`restored ${arg} -> ${DB}`);
} else {
  console.error('usage: backup.mjs backup [file] | restore <file>');
  process.exit(2);
}
