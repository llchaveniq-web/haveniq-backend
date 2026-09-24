// The room question: "do you have a room available?"
//
// It is the first thing students ask each other and the one thing this product
// could not answer. It modelled two people who both need housing looking for
// each other, and nothing else. Olivia has a room and is interviewing
// candidates for it. Talan opened with the question. Two more assumed we were
// advertising a room. None of them could say so, and none of them could find
// someone who had.
//
// Three values because there are three real situations, and the third is the
// only one the app understood before this.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const usersSrc = fs.readFileSync(path.join(__dirname, 'users.js'), 'utf8');
const matchSrc = fs.readFileSync(path.join(__dirname, 'matches.js'), 'utf8');
const migrate  = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrate_missing.sql'), 'utf8');

// The validator is a Set literal in the route; read it rather than retyping it,
// so this test cannot quietly agree with a vocabulary that has drifted.
const roles = (() => {
  const m = /const HOUSING_ROLES = new Set\(\[([^\]]*)\]\)/.exec(usersSrc);
  assert.ok(m, 'HOUSING_ROLES not found');
  return m[1].split(',').map(x => x.trim().replace(/'/g, '')).filter(Boolean);
})();

test('the three situations students are actually in', () => {
  assert.deepStrictEqual(roles.sort(), ['find_together', 'has_room', 'needs_room']);
});

test('the column exists, is nullable and is never backfilled', () => {
  assert.match(migrate, /ALTER TABLE users ADD COLUMN IF NOT EXISTS housing_role TEXT;/);
  // A DEFAULT or an UPDATE would turn "never asked" into an answer, which is
  // the exact mistake move_in_set_at had to be added to undo.
  assert.ok(!/housing_role[^;]*DEFAULT/i.test(migrate), 'housing_role must not carry a default');
  assert.ok(!/UPDATE users SET housing_role/i.test(migrate), 'housing_role must never be backfilled');
});

test('it is patchable, validated, and read back on /users/me', () => {
  assert.match(usersSrc, /housing_role:\s*v => typeof v === 'string' && HOUSING_ROLES\.has\(v\)/);
  assert.match(usersSrc, /housingRole:\s*'housing_role'/);      // camel to snake, patchable
  assert.match(usersSrc, /housingRole:\s*u\.housing_role/);     // comes back out
});

test('an unanswered role leaves the server as null, not as a guess', () => {
  // Everything in this payload that a student did not say has to read as
  // nothing. A default of "looking" would put words in the mouth of every
  // account that predates the question.
  assert.match(matchSrc, /housingRole:\s*r\.housing_role \|\| null/);
});

test('every candidate query that builds a match actually selects it', () => {
  // Three queries feed buildDto. A DTO field whose column is missing from one
  // of them is undefined on that surface only, which is the kind of bug that
  // shows up on one screen and nowhere else.
  const selects = (matchSrc.match(/u\.move_in_timeline,/g) || []).length;
  const roleSel = (matchSrc.match(/u\.housing_role,/g) || []).length;
  assert.strictEqual(roleSel, selects,
    `housing_role is selected ${roleSel} times but move_in_timeline ${selects} times`);
});

test('it is NOT a hard viability filter', () => {
  // Budget and move-in are filters because they are physically impossible to
  // reconcile. Two people who both have a room to fill is awkward, not
  // impossible: one of them can give theirs up. With about thirty candidates a
  // campus, a filter here would cost more than it saves. It is shown, and the
  // student decides.
  const viability = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'matchViability.js'), 'utf8');
  assert.ok(!/housing_role/.test(viability));
});
