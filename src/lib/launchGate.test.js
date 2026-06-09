// Tests for the access gate. CURRENT STATE: OPEN/PUBLIC (PRELAUNCH_LOCK unset).
// These assert the public behavior + that the allowlist is still intact so the
// re-lock path (PRELAUNCH_LOCK=true) keeps working. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const { isAllowed, isLocked, ALLOWLIST } = require('../lib/launchGate');

test('defaults to OPEN / public (no PRELAUNCH_LOCK env)', () => {
  assert.equal(isLocked(), false);
});

test('when open, any verified email is allowed in', () => {
  assert.equal(isAllowed('someone@school.edu'), true);
  assert.equal(isAllowed('another.student@bigstate.edu'), true);
});

test('founder is always in the allowlist (for the re-lock path)', () => {
  assert.ok(ALLOWLIST.has('jberney@student.cccd.edu'));
});

test('invited tester is in the allowlist (for the re-lock path)', () => {
  assert.ok(ALLOWLIST.has('u1579080@umail.com.utah.edu'));
});
