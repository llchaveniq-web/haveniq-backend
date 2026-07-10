'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { splitSqlStatements } = require('./splitSqlStatements');

test('splits plain statements on top-level semicolons', () => {
  const out = splitSqlStatements('CREATE TABLE a (id int);\nCREATE TABLE b (id int);');
  assert.strictEqual(out.length, 2);
  assert.match(out[0], /CREATE TABLE a/);
  assert.match(out[1], /CREATE TABLE b/);
});

test('does NOT split inside a $$…$$ function body', () => {
  const sql = `
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
CREATE TABLE after (id int);`;
  const out = splitSqlStatements(sql);
  assert.strictEqual(out.length, 2, 'function + trailing table = 2 statements');
  // The whole function (open tag through close tag) is ONE statement.
  assert.match(out[0], /CREATE OR REPLACE FUNCTION update_updated_at/);
  assert.match(out[0], /RETURN NEW/);
  assert.match(out[0], /\$\$ LANGUAGE plpgsql/);
  assert.match(out[1], /CREATE TABLE after/);
});

test('respects a named $tag$ dollar-quote', () => {
  const sql = `CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; SELECT 2; $body$ LANGUAGE sql;`;
  const out = splitSqlStatements(sql);
  assert.strictEqual(out.length, 1);
  assert.match(out[0], /\$body\$ SELECT 1; SELECT 2; \$body\$/);
});

test('semicolons and -- inside single-quoted strings are literal', () => {
  const sql = `INSERT INTO t (msg) VALUES ('a; b -- not a comment');\nSELECT 1;`;
  const out = splitSqlStatements(sql);
  assert.strictEqual(out.length, 2);
  assert.match(out[0], /'a; b -- not a comment'/);
});

test("handles '' escaped single quotes", () => {
  const sql = `INSERT INTO t (msg) VALUES ('it''s fine; really');\nSELECT 2;`;
  const out = splitSqlStatements(sql);
  assert.strictEqual(out.length, 2);
  assert.match(out[0], /'it''s fine; really'/);
});

test('strips -- line comments outside strings', () => {
  const sql = `-- a comment with ; inside\nSELECT 1;`;
  const out = splitSqlStatements(sql);
  assert.strictEqual(out.length, 1);
  assert.match(out[0], /SELECT 1/);
  assert.ok(!out[0].includes('comment'));
});

test('$1 param placeholders are NOT treated as dollar-quote tags', () => {
  const out = splitSqlStatements('SELECT $1; SELECT $2;');
  assert.strictEqual(out.length, 2);
});

test('the real migrate_missing.sql: function intact, no fragments', () => {
  const sqlPath = path.resolve(__dirname, '..', 'db', 'migrate_missing.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const out = splitSqlStatements(sql);

  // Exactly one statement carries the whole update_updated_at() function,
  // and it includes its own close tag (i.e. it was not split mid-body).
  const fnStmts = out.filter(s => /CREATE OR REPLACE FUNCTION update_updated_at/.test(s));
  assert.strictEqual(fnStmts.length, 1, 'function defined in exactly one statement');
  assert.match(fnStmts[0], /\$\$\s*LANGUAGE plpgsql/, 'function statement includes its close tag');

  // No statement should be a bare fragment of the split-apart body.
  for (const s of out) {
    const t = s.trim();
    assert.ok(t !== 'RETURN NEW', 'no RETURN NEW fragment');
    assert.ok(t !== 'END', 'no END fragment');
    assert.ok(!/^\$\$\s*LANGUAGE plpgsql$/.test(t), 'no dangling close-tag fragment');
  }
});
