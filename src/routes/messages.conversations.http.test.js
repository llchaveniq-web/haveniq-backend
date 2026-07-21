// GET /messages/conversations — the payload the inbox and thread header render
// the real person from. Pins the participant identity contract (P0) and the
// per-pair category breakdown the new-match fit read is built from (P1), plus
// the privacy line: initial only, never a full surname (see noSurnameLeak.test).
// pool/auth/analytics/email stubbed. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// One conversation row shaped exactly like the real SELECT returns it.
let row = {
  conversation_id: 'conv-1',
  other_user_id: 'user-b',
  first_name: 'Maya',
  last_name: 'Rodriguez',
  school: 'Ohio University',
  school_year: 'Sophomore',
  major: 'Biology',
  photo_url: 'https://cdn.test/maya.jpg',
  is_verified: true,
  trust_score: 70,
  identity_verified_at: '2026-07-01T00:00:00.000Z',
  last_active_at: '2026-07-19T00:00:00.000Z',
  last_message: 'hey!',
  last_message_at: '2026-07-19T06:00:00.000Z',
  last_sender_id: 'user-b',
  unread_count: '2',
  compat_score: '84.5',
  profile_complete: true,
  breakdown: { lifestyle: 91, communication: 78, control: 64, nervous: 88 },
};
let selectSql = '';

inject('../db/pool', {
  query: async (sql) => {
    if (/FROM conversations/.test(sql)) { selectSql = sql; return { rows: row ? [row] : [] }; }
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: 'user-a', email: 'me@ohio.edu' }; next(); },
  refuseBanned: (_req, _res, next) => next(),
});
inject('../services/analytics', { track: () => {} });
inject('../services/email', { sendNewMessageEmail: async () => {}, sendSafetyAlertEmail: async () => {} });

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/messages', require('./messages'));

const get = () => request(app).get('/messages/conversations');

// ── P0: the conversation partner ──
test('the row carries the other participant, not just an id', async () => {
  const res = await get();
  assert.equal(res.status, 200);
  const u = res.body[0].otherUser;
  assert.equal(u.id, 'user-b');
  assert.equal(u.firstName, 'Maya');
  assert.equal(u.photoUrl, 'https://cdn.test/maya.jpg');
});

test('carries the fields the thread header + contact gate depend on', async () => {
  const u = (await get()).body[0].otherUser;
  assert.equal(u.isVerified, true);
  // Non-null identityVerifiedAt is what unlocks contact sharing — a missing
  // field here would silently re-break the anti-scam gate.
  assert.equal(u.identityVerifiedAt, '2026-07-01T00:00:00.000Z');
  assert.equal(u.school, 'Ohio University');
  assert.equal(u.schoolYear, 'Sophomore');
  assert.equal(u.major, 'Biology');
  assert.equal(u.lastActiveAt, '2026-07-19T00:00:00.000Z');
});

test('surname is reduced to an initial and the full name never ships', async () => {
  const u = (await get()).body[0].otherUser;
  assert.equal(u.lastInitial, 'R');
  assert.equal(u.lastName, undefined, 'privacy policy §3: initial only');
  assert.ok(!JSON.stringify(u).includes('Rodriguez'), 'full surname must not appear anywhere in the payload');
});

// ── P1: the fit read ──
test('breakdown is present and matches the feed shape', async () => {
  const b = (await get()).body[0].breakdown;
  assert.deepEqual(b, { lifestyle: 91, communication: 78, control: 64, nervous: 88 });
});

test('breakdown is selected from the SAME scored row as compatScore', async () => {
  await get();
  assert.match(selectSql, /cs\.breakdown/);
  assert.match(selectSql, /cs\.score AS compat_score/);
});

test('an unscored pair yields an empty object, never a fabricated read', async () => {
  const saved = row;
  row = { ...row, breakdown: null, compat_score: null };
  const c = (await get()).body[0];
  assert.deepEqual(c.breakdown, {}, 'empty ⇒ the card stays silent');
  assert.equal(c.compatScore, null);
  row = saved;
});

// ── Honest emptiness: a partner who never filled in a profile ──
test('a nameless/photoless partner passes through as null, not a placeholder', async () => {
  const saved = row;
  row = { ...row, first_name: null, last_name: null, photo_url: null };
  const u = (await get()).body[0].otherUser;
  assert.equal(u.firstName, null, 'the app\'s "Your match" fallback owns this case');
  assert.equal(u.photoUrl, null);
  assert.equal(u.lastInitial, '');
  row = saved;
});

test('the envelope the inbox list renders is intact', async () => {
  const c = (await get()).body[0];
  assert.equal(c.conversationId, 'conv-1');
  assert.equal(c.lastMessage, 'hey!');
  assert.equal(c.unreadCount, 2);
  assert.equal(c.compatScore, 84.5);
  assert.equal(c.isLastSenderMe, false);
});

// ── profileComplete (descriptive only) ──────────────────────────────────────
// Why a row renders as "Your match" + a silhouette: the partner never finished
// the setup screen. The flag reports that; it filters and reorders nothing.
test('a complete partner is flagged complete', async () => {
  const u = (await get()).body[0].otherUser;
  assert.equal(u.profileComplete, true);
});

test('a nameless/photoless partner is flagged INCOMPLETE, and still returned', async () => {
  const saved = row;
  row = { ...row, first_name: null, photo_url: null, profile_complete: false };
  const c = (await get()).body[0];
  assert.equal(c.otherUser.profileComplete, false);
  assert.equal(c.conversationId, 'conv-1', 'nobody is hidden — the flag is descriptive');
  row = saved;
});

test('the flag is computed in SQL from the app\'s own setup requirements', async () => {
  await get();
  // Name + photo only: the fields whose absence yields the silhouette.
  assert.match(selectSql, /btrim\(u\.first_name\)/);
  assert.match(selectSql, /btrim\(u\.photo_url\)/);
  assert.match(selectSql, /AS profile_complete/);
  // A blank last initial or a missing age renders fine ("Jackson", no age chip)
  // and must NOT read as incomplete — the founder's own profile is exactly that.
  const expr = selectSql.slice(0, selectSql.indexOf('AS profile_complete'));
  const tail = expr.slice(expr.lastIndexOf('(u.first_name'));
  assert.ok(!/u\.age/.test(tail), 'age must not gate completeness');
  assert.ok(!/btrim\(u\.last_name\)/.test(tail), 'last initial must not gate completeness');
});
