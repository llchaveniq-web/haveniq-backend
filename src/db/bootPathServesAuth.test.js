const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * The documented boot path must produce a database the auth middleware can query.
 *
 * A new environment is built from schema.sql plus migrate_missing.sql, which
 * server.js applies on every boot. src/db/migrations/*.sql are separate files
 * whose own headers say to apply them BY HAND via the Railway dashboard, so
 * nothing automated applies them and a fresh database does not have them.
 *
 * That had already bitten: 2026-05-24-user-bans.sql adds is_banned, banned_at
 * and ban_reason, and auth.js SELECTs is_banned and ban_reason on EVERY
 * authenticated request. Measured 2026-09-26 against a database built the
 * documented way: GET /users/me with a valid token returned HTTP 500
 * (errorMissingColumn) while smoke-test.sh reported 42 PASS / 0 FAIL, because
 * every route it checks answers 401 before the query runs. A new environment
 * boots green, passes every check, and fails on the first real sign-in.
 *
 * This reads the middleware's own SELECT rather than a list someone maintains.
 * Adding a column to that query without adding it to the boot path fails here.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// The user SELECT in the auth middleware, whichever columns it currently names.
function columnsAuthSelects() {
  const src = read('src', 'middleware', 'auth.js');
  const m = src.match(/SELECT\s+([^']*?)\s+FROM users WHERE id = \$1/i);
  assert.ok(m, 'could not find the user SELECT in src/middleware/auth.js');
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

// Columns of `users` that the boot path actually creates.
function columnsBootPathCreates() {
  const sql = read('src', 'db', 'schema.sql') + '\n' + read('src', 'db', 'migrate_missing.sql');
  const found = new Set();

  // CREATE TABLE users ( ... ) -- take the first identifier of each line.
  const create = sql.match(/CREATE TABLE (?:IF NOT EXISTS )?users\s*\(([\s\S]*?)\n\);/i);
  if (create) {
    for (const line of create[1].split('\n')) {
      const c = line.trim().match(/^([a-z_][a-z0-9_]*)\s+/i);
      if (c && !/^(PRIMARY|UNIQUE|CONSTRAINT|CHECK|FOREIGN)$/i.test(c[1])) found.add(c[1].toLowerCase());
    }
  }
  // ALTER TABLE users ADD COLUMN [IF NOT EXISTS] x -- including multi-column.
  for (const alter of sql.matchAll(/ALTER TABLE\s+(?:ONLY\s+)?users\b([\s\S]*?);/gi)) {
    for (const add of alter[1].matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
      found.add(add[1].toLowerCase());
    }
  }
  return found;
}

test('the auth middleware SELECT is non-trivial (guards this whole file)', () => {
  const cols = columnsAuthSelects();
  // If the regex ever stops matching the real query, every assertion below
  // would pass vacuously. Pin the shape instead of trusting it.
  assert.ok(cols.length >= 8, `parsed only ${cols.length} columns from auth.js`);
  assert.ok(cols.includes('is_banned'), 'expected is_banned among the parsed columns');
});

test('the boot path parser finds the users table (guards this whole file)', () => {
  const cols = columnsBootPathCreates();
  assert.ok(cols.size >= 20, `parsed only ${cols.size} user columns from the boot path`);
  assert.ok(cols.has('email'), 'expected email among the boot-path columns');
});

test('every column auth.js selects exists after schema.sql + migrate_missing.sql', () => {
  const need = columnsAuthSelects();
  const have = columnsBootPathCreates();
  const missing = need.filter(c => !have.has(c.toLowerCase()));
  assert.deepStrictEqual(
    missing, [],
    `a fresh database would 500 on every authenticated request; missing: ${missing.join(', ')}`
  );
});
