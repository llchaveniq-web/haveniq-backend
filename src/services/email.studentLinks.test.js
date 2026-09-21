// Every notice a student gets must be a way back INTO the app. The connect
// request, new message, new match and welcome emails ended in "Open HavenIQ"
// with no link at all (the welcome's only link was to support), so a student
// told someone wanted to room with them had to go and find the app. Resend is
// stubbed; nothing is sent. node --test.
const test = require('node:test');
const assert = require('node:assert');

const sent = [];
const resendPath = require.resolve('resend');
require.cache[resendPath] = { id: resendPath, filename: resendPath, loaded: true,
  exports: { Resend: class { constructor() { this.emails = { send: async (m) => { sent.push(m); return {}; } }; } } } };
const email = require('./email');
const APP = 'https://app.haveniq.org';

async function last(fn) { sent.length = 0; await fn(); return sent[0]; }

const CASES = [
  ['welcome',         () => email.sendWelcomeEmail('s@csulb.edu'),                              APP],
  ['connect request', () => email.sendConnectRequestEmail('s@csulb.edu', 'Sam', 'Jordan', 87),  `${APP}/matches`],
  ['new message',     () => email.sendNewMessageEmail('s@csulb.edu', 'Sam', 'Jordan'),          `${APP}/messages`],
  ['new match',       () => email.sendMatchEmail('s@csulb.edu', 'Sam', 'Jordan', 87),           `${APP}/matches`],
  ['request accepted', () => email.sendConnectAcceptedEmail('s@csulb.edu', 'Sam', 'Jordan', 87), `${APP}/messages`],
];

for (const [name, send, url] of CASES) {
  test(`${name}: the button and the plain text both lead into the app`, async () => {
    const m = await last(send);
    assert.ok(m.html.includes(`href="${url}"`), `${name} html has no link to ${url}`);
    assert.ok(m.text && m.text.includes(url), `${name} text part is missing or has no link`);
  });
}

test('a name a student typed is escaped in the HTML', async () => {
  const m = await last(() => email.sendConnectRequestEmail('s@csulb.edu', 'Sam', '<img src=x onerror=alert(1)>', 87));
  assert.equal(m.html.includes('<img src=x'), false);
  assert.ok(m.html.includes('&lt;img src=x'));
});

test('the welcome no longer promises a quiz the student already took', async () => {
  const m = await last(() => email.sendWelcomeEmail('s@csulb.edu'));
  assert.equal(/one quiz away/i.test(m.subject), false);
});

test('the accepted email says what happened, not to go and send a request', async () => {
  const m = await last(() => email.sendConnectAcceptedEmail('s@csulb.edu', 'Sam', 'Jordan K.', 87));
  assert.match(m.subject, /accepted your request/);
  assert.equal(/send (a|your first) connect request/i.test(m.text + m.html), false);
});
