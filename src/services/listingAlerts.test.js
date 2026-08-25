// listingAlerts — fan-out when a new listing matches someone's saved alert.
//
// Two different things are checked here, because they fail differently:
//
//   1. BEHAVIOUR, with the pool stubbed: does everyone matched get both
//      channels, is the fan-out really detached from failure, does a dead
//      Resend take the whole thing down. This is the part that spams people or
//      silently reaches nobody.
//   2. The SQL TEXT, as a contract. The pool is stubbed, so the query itself
//      never executes here and its correctness cannot be proven without a
//      database. But its three load-bearing clauses — exclude the creator, and
//      treat a NULL budget / NULL min-beds as "no opinion" rather than "match
//      nothing" — can at least be pinned so they aren't deleted by accident.
//      Dropping the creator clause pushes the founder about their own listing;
//      inverting the NULL handling makes the whole feature silently dead.
//
// DB + email stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let queries = [];
let rowsToReturn = [];

inject('../db/pool', {
  query: async (sql, params = []) => {
    queries.push({ sql, params });
    if (/UPDATE listing_alerts/i.test(sql)) return { rows: [] };
    return { rows: rowsToReturn };
  },
});

let emails = [];
let emailShouldThrow = false;
inject('./email', {
  sendListingAlertEmail: async (args) => {
    if (emailShouldThrow) throw new Error('resend down');
    emails.push(args);
  },
});

const { notifyNewListing, findMatchingAlerts, dollars } = require('./listingAlerts');

const LISTING = {
  id: 'l-1',
  address: '412 Bardeen Ave',
  city: 'Irvine',
  school_near: 'UC Irvine',
  beds: 2,
  per_person_rent_cents: 95000,   // $950
  created_by: 'founder-1',
};

function reset() {
  queries = [];
  rowsToReturn = [];
  emails = [];
  emailShouldThrow = false;
}

test('notifies every matched user on BOTH channels', async () => {
  reset();
  rowsToReturn = [
    { user_id: 'u-1', email: 'a@uci.edu', first_name: 'Alex' },
    { user_id: 'u-2', email: 'b@uci.edu', first_name: 'Bea' },
  ];
  const pushed = [];
  const res = await notifyNewListing(LISTING, async (uid, payload) => { pushed.push({ uid, payload }); });

  assert.equal(res.notified, 2);
  assert.deepEqual(pushed.map(p => p.uid).sort(), ['u-1', 'u-2']);
  assert.deepEqual(emails.map(e => e.toEmail).sort(), ['a@uci.edu', 'b@uci.edu']);
});

test('push carries the listing id so the app can deep-link to it', async () => {
  reset();
  rowsToReturn = [{ user_id: 'u-1', email: 'a@uci.edu', first_name: 'Alex' }];
  const pushed = [];
  await notifyNewListing(LISTING, async (uid, payload) => { pushed.push(payload); });

  assert.equal(pushed[0].data.listingId, 'l-1');
  // Dollars, not cents. A unit slip here shows students "$95000/mo".
  assert.match(pushed[0].body, /\$950\/mo/);
});

test('sends the email even when there is no push transport at all', async () => {
  // Web users have no push token. Email is the primary channel, not a fallback,
  // and passing no sender must not skip it.
  reset();
  rowsToReturn = [{ user_id: 'u-1', email: 'a@uci.edu', first_name: 'Alex' }];
  const res = await notifyNewListing(LISTING, null);

  assert.equal(res.notified, 1);
  assert.equal(emails.length, 1);
});

test('a dead email provider does not take the fan-out down', async () => {
  reset();
  emailShouldThrow = true;
  rowsToReturn = [{ user_id: 'u-1', email: 'a@uci.edu', first_name: 'Alex' }];
  const pushed = [];
  const res = await notifyNewListing(LISTING, async (uid, p) => { pushed.push(p); });

  assert.equal(res.notified, 1);
  assert.equal(pushed.length, 1, 'push still went out');
});

test('no matches means no sends and no error', async () => {
  reset();
  rowsToReturn = [];
  let pushCalls = 0;
  const res = await notifyNewListing(LISTING, async () => { pushCalls += 1; });

  assert.equal(res.notified, 0);
  assert.equal(pushCalls, 0);
  assert.equal(emails.length, 0);
});

test('a thrown push never rejects out of the fan-out', async () => {
  // Called fire-and-forget from the create route: an unhandled rejection here
  // would surface as a crash far from its cause.
  reset();
  rowsToReturn = [{ user_id: 'u-1', email: 'a@uci.edu', first_name: 'Alex' }];
  await assert.doesNotReject(() =>
    notifyNewListing(LISTING, async () => { throw new Error('bad token'); }));
});

test('singular bed reads "1 bed", not "1 beds"', async () => {
  reset();
  rowsToReturn = [{ user_id: 'u-1', email: 'a@uci.edu', first_name: 'Alex' }];
  const pushed = [];
  await notifyNewListing({ ...LISTING, beds: 1 }, async (uid, p) => { pushed.push(p); });
  assert.match(pushed[0].body, /1 bed\b/);
  assert.doesNotMatch(pushed[0].body, /1 beds/);
});

test('dollars() converts cents without drifting', () => {
  assert.equal(dollars(95000), 950);
  assert.equal(dollars(99999), 1000);
});

test('the matching query keeps its three load-bearing clauses', async () => {
  reset();
  rowsToReturn = [];
  await findMatchingAlerts(LISTING);
  const sql = queries[0].sql;

  // Without this the founder gets pushed about their own listing.
  assert.match(sql, /la\.user_id <> \$2/);
  // NULL means "no opinion". Inverting either of these silently kills the
  // feature for everyone who left the field blank.
  assert.match(sql, /la\.max_per_person_cents IS NULL OR/);
  assert.match(sql, /la\.min_beds IS NULL OR/);
  assert.match(sql, /la\.is_active = TRUE/);
});
