// POST /messages/:conversationId — the email-on-every-message fix.
//
// maybeEmailNewMessage used to gate on "is exactly 1 message unread right
// now" as a proxy for "email once per burst, not once per message." That's
// backwards during an ACTUAL conversation: the thread screen marks messages
// read on a 3s poll, so between two people actively texting, each reply
// lands with the recipient already caught up (unread count resets to 1
// every time) — so it re-emailed on EVERY message, ~40 times for a
// 40-message evening. This locks the real fix: skip entirely when the
// recipient is online (isUserOnline, wired from server.js's socket
// presence tracking) — they'll see it live, which is the state an active
// conversation is actually in — and otherwise throttle by TIME per
// conversation, not by unread-count. pool/auth/analytics/email stubbed;
// contentFilter runs for real (ordinary text is 'allow'). node --test.
const test = require('node:test');
const assert = require('node:assert/strict');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const ME = 'user-a';
const OTHER = 'user-b';

let convRow = { user_a: ME, user_b: OTHER, ended_at: null };
let blockRow = null;
let emailCalls = [];
let onlineUsers = new Set();

inject('../db/pool', {
  query: async (sql, params) => {
    if (/SELECT user_a, user_b, ended_at FROM conversations/.test(sql)) {
      return { rows: convRow ? [convRow] : [] };
    }
    if (/FROM user_blocks/.test(sql)) {
      return { rows: blockRow ? [blockRow] : [] };
    }
    if (/INSERT INTO messages/.test(sql)) {
      return { rows: [{ id: `m-${Date.now()}-${Math.random()}`, conversation_id: params[0], sender_id: params[1], body: params[2], read: false, created_at: new Date().toISOString() }] };
    }
    if (/SELECT email, first_name FROM users WHERE id = \$1/.test(sql)) {
      return { rows: [{ email: 'other@ohio.edu', first_name: 'Sam' }] };
    }
    return { rows: [] };
  },
});
inject('../middleware/auth', {
  requireAuth: (req, _res, next) => { req.user = { id: ME, first_name: 'Jordan' }; next(); },
  refuseBanned: (_req, _res, next) => next(),
});
inject('../services/analytics', {
  track: () => {},
  EVENTS: { message_received: 'message_received' },
});
inject('../services/email', {
  sendNewMessageEmail: async (email, name, senderName, recipientId) => { emailCalls.push({ email, name, senderName, recipientId }); },
  sendSafetyAlertEmail: async () => {},
});

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.set('isUserOnline', (uid) => onlineUsers.has(uid));
app.use('/messages', require('./messages'));

const send = (conversationId, body) => request(app).post(`/messages/${conversationId}`).send({ body });
const settle = () => new Promise((r) => setImmediate(r));

test.beforeEach(() => {
  convRow = { user_a: ME, user_b: OTHER, ended_at: null };
  blockRow = null;
  emailCalls = [];
  onlineUsers = new Set();
});

test('recipient online: no email is sent — they will see it live', async () => {
  onlineUsers.add(OTHER);
  const res = await send('conv-online', 'hey, are you around later?');
  assert.equal(res.status, 201);
  await settle();
  assert.equal(emailCalls.length, 0);
});

test('recipient offline: the first message emails them', async () => {
  const res = await send('conv-offline-1', 'hey! quick question about move-in');
  assert.equal(res.status, 201);
  await settle();
  assert.equal(emailCalls.length, 1);
  assert.equal(emailCalls[0].recipientId, OTHER);
});

test('recipient offline, active back-and-forth: does NOT email on every message — this is the bug', async () => {
  const conversationId = 'conv-offline-burst';
  await send(conversationId, 'message one');
  await settle();
  await send(conversationId, 'message two, right after');
  await settle();
  await send(conversationId, 'message three');
  await settle();
  assert.equal(emailCalls.length, 1, 'a burst while offline emails ONCE, not once per message');
});

test('a different conversation is NOT throttled by another conversation\'s cooldown', async () => {
  await send('conv-a', 'hi there');
  await settle();
  await send('conv-b', 'separate conversation, separate person effectively');
  await settle();
  assert.equal(emailCalls.length, 2, 'cooldown is scoped per conversation');
});
