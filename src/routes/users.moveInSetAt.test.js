// PATCH /users/me stamps move_in_set_at whenever moveInTimeline is saved, so
// the server can tell a real move-in answer from what the old lease picker
// left behind. Reads the handler source. node --test.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'users.js'), 'utf8');

test('saving a move-in stamps when it was answered', () => {
  assert.match(src, /changed\.includes\('moveInTimeline'\)\) updates\.push\('move_in_set_at = NOW\(\)'\)/);
});

test('the column exists in the boot migration', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrate_missing.sql'), 'utf8');
  assert.match(sql, /ALTER TABLE users ADD COLUMN IF NOT EXISTS move_in_set_at TIMESTAMPTZ;/);
});

test('/users/me tells the app whether move-in was really answered', () => {
  assert.match(src, /moveInSetAt:\s+u\.move_in_set_at \?\? null/);
});
