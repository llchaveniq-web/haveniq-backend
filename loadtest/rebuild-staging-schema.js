#!/usr/bin/env node
/**
 * Rebuild an EMPTY staging Postgres to match prod's schema.
 * The backend boot only applies migrate_missing.sql — NOT src/db/migrations/*.sql
 * — so a fresh/old staging DB is missing columns (is_banned, last_name, …) and
 * every authed request 500s. This drops + recreates public schema and applies
 * schema.sql + migrate_missing.sql + ALL migrations/*.sql.
 *
 * SAFETY: refuses unless ALLOW_STAGING_REBUILD=true AND the DB has <=5 users
 * (i.e. it's the disposable staging DB, never prod). Prints the target host.
 *
 * Usage:
 *   DATABASE_URL='<staging PUBLIC url, e.g. hayabusa.proxy.rlwy.net>' \
 *   ALLOW_STAGING_REBUILD=true node loadtest/rebuild-staging-schema.js
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { splitSqlStatements } = require('../src/lib/splitSqlStatements');

const DB = path.join(__dirname, '..', 'src', 'db');
if (process.env.ALLOW_STAGING_REBUILD !== 'true') { console.error('Set ALLOW_STAGING_REBUILD=true (staging only).'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL to the staging PUBLIC url.'); process.exit(1); }
let host = '?'; try { host = new URL(process.env.DATABASE_URL).host; } catch {}
console.log('target DB host:', host);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });

async function applyFile(c, file) {
  const stmts = splitSqlStatements(fs.readFileSync(file, 'utf8'));
  let ok = 0, fail = 0;
  for (const s of stmts) { if (!s.trim()) continue; try { await c.query(s); ok++; } catch { fail++; } }
  console.log(`${path.basename(file)}: ${ok} ok, ${fail} failed`);
}

(async () => {
  const c = await pool.connect();
  try {
    let users = 0; try { users = (await c.query('select count(*)::int n from users')).rows[0].n; } catch {}
    if (users > 5) throw new Error(`ABORT: ${users} users — not a disposable staging DB`);
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;');
    await c.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; CREATE EXTENSION IF NOT EXISTS pgcrypto;');
    await applyFile(c, path.join(DB, 'schema.sql'));
    await applyFile(c, path.join(DB, 'migrate_missing.sql'));
    for (const f of fs.readdirSync(path.join(DB, 'migrations')).filter(x => x.endsWith('.sql')).sort()) {
      await applyFile(c, path.join(DB, 'migrations', f));
    }
    const t = (await c.query("select count(*)::int n from information_schema.tables where table_schema='public'")).rows[0].n;
    console.log(`DONE — ${t} tables. Now deploy current code: railway up -e staging -s haveniq-backend --ci`);
  } finally { c.release(); await pool.end(); }
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
