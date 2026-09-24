// The verification mail carries a link, and the link is the safe kind.
//
// Three students have now had a code DELIVERED and never typed a digit:
// attempts = 0 on every otp_codes row, two at LBCC on 2026-09-16 and one at
// Valencia on 2026-09-23. All three schools are Microsoft tenants. Finding the
// mail in a junk folder was only the first half of what we asked. The second
// half was memorising six digits, switching apps, finding the tab they left
// open, and typing them before the clock ran out.
//
// The link lands on the verify screen with the code filled in and still needs a
// tap to submit. That is the whole security argument: Microsoft Defender Safe
// Links fetches every URL in a message before the student ever sees it, so a
// link that verified on GET would be spent by the scanner at exactly the
// schools this exists to help. These tests hold that shape in place.
const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'x'.repeat(48);
process.env.APP_PUBLIC_URL = 'https://app.haveniq.org';

// Stub Resend: capture the payload, send nothing.
let sent = null;
const resendPath = require.resolve('resend');
require.cache[resendPath] = {
  id: resendPath, filename: resendPath, loaded: true,
  exports: { Resend: class { constructor() { this.emails = { send: async (p) => { sent = p; return { id: 'stub' }; } }; } } },
};

const { sendOTPEmail } = require('./email');
const { OTP_TTL_MINUTES } = require('../lib/otp');

const SIGNUP = { school: 'Valencia College', schoolDomain: 'mail.valenciacollege.edu' };
const send = (signup) => sendOTPEmail('tindasorn@mail.valenciacollege.edu', '944335', '', null, signup);

test('the code still leads the subject line, where truncation cannot reach it', async () => {
  await send(SIGNUP);
  assert.match(sent.subject, /^944335 /);
});

test('signup mail carries the link, in BOTH the plain and html parts', async () => {
  await send(SIGNUP);
  // Plain text matters most here: a junk folder often previews it, and some
  // clients render nothing else.
  assert.match(sent.text, /https:\/\/app\.haveniq\.org\/verify\?/);
  assert.match(sent.html, /href="https:\/\/app\.haveniq\.org\/verify\?/);
});

test('the link carries email, school and domain, each encoded', async () => {
  await send(SIGNUP);
  const href = /href="([^"]*\/verify\?[^"]*)"/.exec(sent.html)[1];
  const u = new URL(href);
  assert.strictEqual(u.searchParams.get('email'), 'tindasorn@mail.valenciacollege.edu');
  // Without these two, /verify-code answers "school and schoolDomain are
  // required for new signups" and the link is useless to the one person it was
  // built for: someone who does not have an account yet.
  assert.strictEqual(u.searchParams.get('school'), 'Valencia College');
  assert.strictEqual(u.searchParams.get('domain'), 'mail.valenciacollege.edu');
  assert.strictEqual(u.searchParams.get('code'), '944335');
});

test('the link only ever points at the verify SCREEN, never at an API that acts', async () => {
  await send(SIGNUP);
  const href = /href="([^"]*\/verify\?[^"]*)"/.exec(sent.html)[1];
  const u = new URL(href);
  assert.strictEqual(u.pathname, '/verify', 'a scanner prefetching this must only draw a page');
  // Nothing that reads as "do it now". A GET that verifies is a GET a link
  // scanner spends before the student arrives.
  assert.ok(!/\/auth\//.test(href));
  assert.ok(!/verify-code/.test(href));
});

test('no link when there is no signup to finish', async () => {
  // /auth/resend-verification and the founder resend call this for people who
  // already have accounts. There is no school to put in the URL and no account
  // to create, so there is no link.
  sent = null;
  await sendOTPEmail('someone@berkeley.edu', '111111');
  assert.ok(!/\/verify\?/.test(sent.text));
  assert.ok(!/Verify my email/.test(sent.html));
});

test('a half-known signup gets no link rather than a broken one', async () => {
  for (const partial of [{ school: 'Valencia College' }, { schoolDomain: 'x.edu' }, {}, null]) {
    sent = null;
    await send(partial);
    assert.ok(!/\/verify\?/.test(sent.text), `built a link from ${JSON.stringify(partial)}`);
  }
});

test('the stated lifetime comes from the constant, in all three places', async () => {
  await send(SIGNUP);
  const stated = `${OTP_TTL_MINUTES} minutes`;
  assert.ok(sent.text.includes(stated), 'plain text');
  // The preheader (the preview line a junk list shows) and the body copy.
  assert.strictEqual(sent.html.split(stated).length - 1, 2, 'preheader + body');
  assert.ok(!/10 minutes/.test(sent.text + sent.html), 'a hardcoded 10 survived');
});
