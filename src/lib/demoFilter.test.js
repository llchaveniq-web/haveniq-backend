// The demo/test-account exclusion is conservative by design: any .test TLD, any
// @demo.* or @*-demo.* domain is treated as non-real. Genuine school addresses
// must NOT be excluded. node --test.
const test = require('node:test');
const assert = require('node:assert');
const { isDemoEmail, notDemo, isDemo } = require('./demoFilter');

test('isDemoEmail: excludes every demo/test flavor', () => {
  for (const e of [
    'sim@demo.haveniq.test',      // .test TLD + @demo.*  (the cohort-sim domain)
    'x@demo.haveniq.app',         // @demo.*
    'seed@haveniq-demo.edu',      // @*-demo.*
    'anyone@foo.test',            // bare .test TLD
    'MixedCase@DEMO.Haveniq.APP', // case-insensitive
  ]) {
    assert.equal(isDemoEmail(e), true, `should exclude ${e}`);
  }
});

test('isDemoEmail: does NOT exclude genuine student addresses', () => {
  for (const e of [
    'jane@berkeley.edu',
    'j.smith@calpoly.edu',
    'demo.smith@university.edu',  // "demo" in the local-part, real domain → keep
    'john@demoschool.edu',        // "@demos…" not "@demo." → keep
    'a@my-demoxyz.edu',           // "-demox" not "-demo." → keep
    'student@test-university.edu',// "test-" not a .test TLD → keep
  ]) {
    assert.equal(isDemoEmail(e), false, `should KEEP ${e}`);
  }
});

test('SQL forms carry the broadened patterns and compose safely', () => {
  const nd = notDemo('u.email');
  for (const p of ['%.test', '%@demo.%', '%-demo.%']) assert.ok(isDemo('u.email').includes(`ILIKE '${p}'`), `isDemo has ${p}`);
  assert.ok(nd.startsWith('(NOT '), 'notDemo is a self-contained negation');
  assert.ok(nd.includes('u.email ILIKE'), 'notDemo references the column');
});

// ── users.is_demo ──────────────────────────────────────────────────────────
// The shape patterns cannot see an account seeded by hand on a real school
// domain. Five such rows (alex.chen@usc.edu and friends) were counted as real
// students by every caller, and the lifecycle mail they were sent hard bounced
// at USC and cost sender reputation. The flag is the fix; these lock it in.

test('demoFlagFor: derives the is_demo column from the email column', () => {
  const { demoFlagFor } = require('./demoFilter');
  assert.equal(demoFlagFor('u.email'), 'u.is_demo');
  assert.equal(demoFlagFor('a.email'), 'a.is_demo');
  assert.equal(demoFlagFor('email'), 'is_demo');
  // Derived rather than passed separately so all nineteen existing call sites
  // keep working unedited.
});

test('SQL forms consult the flag as well as the shape', () => {
  assert.ok(isDemo('u.email').includes('u.is_demo'), 'aliased flag');
  assert.ok(isDemo('email').includes('is_demo'), 'bare flag');
  assert.ok(notDemo('u.email').includes('u.is_demo'), 'notDemo carries it through');
});

test('the flag comparison is NULL-safe', () => {
  // The column is NOT NULL, but a LEFT JOIN still yields NULL for it, and
  // `NOT (… OR NULL)` is NULL, not true. Without COALESCE that would silently
  // drop every real student from any query using one.
  for (const col of ['u.email', 'email']) {
    assert.ok(isDemo(col).includes('COALESCE('), `${col}: flag is COALESCEd`);
    assert.ok(isDemo(col).includes(', FALSE) = TRUE'), `${col}: defaults to not-demo`);
  }
});

test('the shape patterns are unchanged by the flag', () => {
  // The flag is ADDITIVE. A regression that replaced the patterns with it
  // would let every cohort-sim address back into lifecycle email.
  for (const p of ['%.test', '%@demo.%', '%-demo.%']) {
    assert.ok(isDemo('u.email').includes(`ILIKE '${p}'`), `still has ${p}`);
  }
});

test('isDemoEmail does NOT try to guess a flagged address', () => {
  // It only ever receives a string. Widening it to catch a seeded @usc.edu
  // address would necessarily catch real USC students too, which is the exact
  // reason the column exists.
  assert.equal(isDemoEmail('alex.chen@usc.edu'), false);
  assert.equal(isDemoEmail('jane@usc.edu'), false);
});
