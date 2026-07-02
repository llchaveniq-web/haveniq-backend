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
