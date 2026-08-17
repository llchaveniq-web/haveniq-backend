// scoreNewMatches — the review-gate fix.
//
// Load-bearing invariants:
//   1. An unverified (pending-review) submitter is quarantined: scoreNewMatches
//      returns immediately, writing NOTHING — not scored against anyone, in
//      either direction. This is what actually keeps an unreviewed/potential
//      catfish account invisible until the signup-review bot or founder
//      approves it (is_verified alone is a badge; this is the enforcement).
//   2. A verified submitter's candidate query excludes is_verified = FALSE
//      candidates, so an unreviewed profile never gets surfaced to a real,
//      verified student either.
//   3. A verified submitter with only verified candidates scores normally
//      (no behavior change for the steady state).
//   4. Same two rules for is_banned: a banned submitter is quarantined (was
//      previously NOT checked here at all — a banned user who could still
//      reach the quiz-submit route would get freshly scored against real
//      students), and a banned candidate is excluded from everyone else's
//      candidate query (was previously missing here too — matches.js's
//      feed-read queries filtered is_banned, but this write-time query
//      didn't, so a banned account kept accumulating fresh
//      compatibility_scores rows against real, currently-active users
//      every time anyone else edited their quiz).
//   5. The unverified quarantine used to be a bare early `return` — no log,
//      no event, no signal anywhere that this ever happens. It now fires an
//      analytics event, so "how many people are stuck pending review" is
//      answerable from data instead of a support ticket guess.
//
// Pool stubbed; real scoring/dimension/drift/text-insight services run for
// real (they're pure computation once given empty DB inputs). node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let queries = [];
let usersById = new Map();
let candidateRows = [];
let insertedScoreParams = null;
let trackedEvents = [];

inject('../db/pool', {
  query: async (sql, params = []) => {
    queries.push({ sql, params });
    if (/SELECT school, dealbreakers, validation_score, move_in_timeline, is_verified, is_banned FROM users WHERE id = \$1/i.test(sql)) {
      const u = usersById.get(params[0]);
      return { rows: u ? [u] : [] };
    }
    if (/FROM quiz_answers qa\s*\n\s*JOIN users u ON u.id = qa.user_id\s*\n\s*WHERE qa.completed = TRUE/i.test(sql)) {
      return { rows: candidateRows };
    }
    if (/INSERT INTO compatibility_scores/i.test(sql)) {
      insertedScoreParams = params;
      return { rows: [] };
    }
    // dimensionModel / pulseDrift / textInsight loaders and anything else —
    // empty result keeps them all no-ops (proven pure once fed nothing).
    return { rows: [] };
  },
});
inject('../services/analytics', {
  track: (event, userId, props) => { trackedEvents.push({ event, userId, props }); },
  EVENTS: { scoring_skipped_unverified: 'scoring_skipped_unverified' },
});

const { scoreNewMatches } = require('./quiz');

const SUBMITTER_ANSWERS = { 1: { type: 'option', index: 0 } };
const CANDIDATE_ANSWERS = { 1: { type: 'option', index: 1 } };

test.beforeEach(() => {
  queries = [];
  usersById = new Map();
  candidateRows = [];
  insertedScoreParams = null;
  trackedEvents = [];
});

test('unverified submitter: scoreNewMatches writes NOTHING (quarantined until reviewed)', async () => {
  usersById.set('u-pending', { school: 'UCLA', dealbreakers: [], validation_score: null, move_in_timeline: null, is_verified: false });
  candidateRows = [{ user_id: 'u-other', answers: CANDIDATE_ANSWERS, dealbreakers: [], validation_score: null }];

  await scoreNewMatches('u-pending', SUBMITTER_ANSWERS);

  assert.equal(queries.length, 1, 'only the initial submitter lookup ran — no candidate query, no insert');
  assert.match(queries[0].sql, /SELECT school, dealbreakers, validation_score, move_in_timeline, is_verified/);
  assert.equal(insertedScoreParams, null);
});

test('unverified submitter: the quarantine is now OBSERVABLE — it fires an event instead of vanishing silently', async () => {
  usersById.set('u-pending', { school: 'UCLA', dealbreakers: [], validation_score: null, move_in_timeline: null, is_verified: false });

  await scoreNewMatches('u-pending', SUBMITTER_ANSWERS);

  assert.equal(trackedEvents.length, 1);
  assert.equal(trackedEvents[0].event, 'scoring_skipped_unverified');
  assert.equal(trackedEvents[0].userId, 'u-pending');
});

test('a verified submitter never fires the skipped-unverified event', async () => {
  usersById.set('u-verified', { school: 'UCLA', dealbreakers: [], validation_score: null, move_in_timeline: null, is_verified: true });
  candidateRows = [];

  await scoreNewMatches('u-verified', SUBMITTER_ANSWERS);

  assert.equal(trackedEvents.length, 0);
});

test('verified submitter: candidate query excludes is_verified = FALSE users', async () => {
  usersById.set('u-verified', { school: 'UCLA', dealbreakers: [], validation_score: null, move_in_timeline: null, is_verified: true });
  candidateRows = []; // no candidates returned — the point is the SQL filter, asserted below

  await scoreNewMatches('u-verified', SUBMITTER_ANSWERS);

  const candidateQuery = queries.find(q => /FROM quiz_answers qa/.test(q.sql));
  assert.ok(candidateQuery, 'candidate query ran for a verified submitter');
  assert.match(candidateQuery.sql, /u\.is_verified = TRUE/, 'unreviewed candidates must never be surfaced to a verified student');
});

test('verified submitter scored against a verified candidate: writes a compatibility_scores row (steady state unaffected)', async () => {
  usersById.set('u-verified', { school: 'UCLA', dealbreakers: [], validation_score: null, move_in_timeline: null, is_verified: true });
  candidateRows = [{ user_id: 'u-other-verified', answers: CANDIDATE_ANSWERS, dealbreakers: [], validation_score: null }];

  await scoreNewMatches('u-verified', SUBMITTER_ANSWERS);

  assert.ok(insertedScoreParams, 'a compatibility_scores row was written for the verified pair');
  assert.ok(insertedScoreParams.includes('u-verified') || insertedScoreParams.includes('u-other-verified'));
});

test('banned submitter (even if verified): scoreNewMatches writes NOTHING', async () => {
  usersById.set('u-banned', { school: 'UCLA', dealbreakers: [], validation_score: null, move_in_timeline: null, is_verified: true, is_banned: true });
  candidateRows = [{ user_id: 'u-other', answers: CANDIDATE_ANSWERS, dealbreakers: [], validation_score: null }];

  await scoreNewMatches('u-banned', SUBMITTER_ANSWERS);

  assert.equal(queries.length, 1, 'only the initial submitter lookup ran — no candidate query, no insert');
  assert.equal(insertedScoreParams, null);
});

test('verified submitter: candidate query excludes banned users too', async () => {
  usersById.set('u-verified', { school: 'UCLA', dealbreakers: [], validation_score: null, move_in_timeline: null, is_verified: true });
  candidateRows = [];

  await scoreNewMatches('u-verified', SUBMITTER_ANSWERS);

  const candidateQuery = queries.find(q => /FROM quiz_answers qa/.test(q.sql));
  assert.ok(candidateQuery);
  assert.match(candidateQuery.sql, /COALESCE\(u\.is_banned, FALSE\) = FALSE/, 'a banned account must never be freshly scored against a real, active student');
});
