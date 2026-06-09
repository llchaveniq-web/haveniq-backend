// Tests for the pre-launch access gate. These protect the "only allowlisted
// people can get in" guarantee — a regression here could silently open the
// app to the public OR lock the founder out. Run with `npm test`.
//
// Note: launchGate reads env at module load, so this file tests the DEFAULT
// (locked) state — which is the live, security-critical configuration.
const test = require('node:test');
const assert = require('node:assert');
const { isAllowed, isLocked } = require('../lib/launchGate');

test('defaults to LOCKED (fail-safe)', () => {
  assert.equal(isLocked(), true);
});

test('founder is always allowed (exact)', () => {
  assert.equal(isAllowed('jberney@student.cccd.edu'), true);
});

test('founder allowed regardless of casing / whitespace', () => {
  assert.equal(isAllowed('  JBerney@Student.CCCD.edu '), true);
});

test('invited tester is allowed', () => {
  assert.equal(isAllowed('u1579080@umail.com.utah.edu'), true);
});

test('a random .edu is blocked while locked', () => {
  assert.equal(isAllowed('someone@school.edu'), false);
});

test('empty / null email is blocked', () => {
  assert.equal(isAllowed(''), false);
  assert.equal(isAllowed(null), false);
  assert.equal(isAllowed(undefined), false);
});
