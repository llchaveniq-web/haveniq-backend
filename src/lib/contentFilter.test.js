// Tests for first-line message moderation. Protects the "block egregious,
// flag scams, allow normal chat" contract so a regex edit can't silently
// start blocking real students or letting abuse through. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const { screenMessage, detectThreatSignal } = require('./contentFilter');

test('normal roommate chat is allowed', () => {
  assert.equal(screenMessage('hey! are you still looking for a place near campus?').action, 'allow');
});

test('ordinary profanity is NOT blocked or flagged', () => {
  // Adults swear; flagging this would flood the queue and frustrate users.
  assert.equal(screenMessage('ugh this is so damn annoying').action, 'allow');
});

test('blocks a demeaning slur (hate)', () => {
  const r = screenMessage("don't be such a retard");
  assert.equal(r.action, 'block');
  assert.equal(r.category, 'hate');
});

test('blocks explicit sexual solicitation', () => {
  const r = screenMessage('send nudes');
  assert.equal(r.action, 'block');
  assert.equal(r.category, 'sexual');
});

test('blocks a violent threat', () => {
  const r = screenMessage("i'll kill you");
  assert.equal(r.action, 'block');
  assert.equal(r.category, 'threat');
});

// The threat rules used to have no subject-gating and included words with
// heavy benign idiomatic use in exactly the context this app puts people in
// (arranging to meet up) — so real messages between real matched students
// were being deleted and logged as threats. This locks the fix: none of
// these ordinary sentences trip the filter.
test('meetup language with "find"/"shoot" is not mistaken for a threat', () => {
  assert.equal(screenMessage("I'll find you outside the dining hall at 7").action, 'allow');
  assert.equal(screenMessage("i'll find you after class").action, 'allow');
  assert.equal(screenMessage("I'll shoot you a text when I'm heading over").action, 'allow');
  assert.equal(screenMessage('shoot you an email with the numbers').action, 'allow');
});

test('hyperbole and impersonal subjects with "kill" are not mistaken for a threat', () => {
  assert.equal(screenMessage('that 8am is gonna kill you lol').action, 'allow');
  assert.equal(screenMessage('the walk up that hill will kill you').action, 'allow');
});

test('a negated "hurt" — the opposite of a threat — is not blocked', () => {
  const r = screenMessage("I'd never want to hurt you, just being honest about the noise thing");
  assert.equal(r.action, 'allow');
});

test('the "beat you to it" racing idiom is not mistaken for a threat', () => {
  assert.equal(screenMessage("I'll beat you to it").action, 'allow');
});

// Real first-person threats still block, in both word orders for "beat up".
test('real first-person violent threats still block', () => {
  assert.equal(screenMessage('I will hurt you').action, 'block');
  assert.equal(screenMessage('i am gonna rape you').action, 'block');
  assert.equal(screenMessage("I'll end you").action, 'block');
  assert.equal(screenMessage('I will murder you').action, 'block');
  assert.equal(screenMessage("I'll stab you").action, 'block');
  assert.equal(screenMessage("I'll beat you up").action, 'block');
  assert.equal(screenMessage("I'm gonna beat up you").action, 'block');
});

// "find you" ALONE stays unblocked at any subject-gating tier — see the
// meetup test above. But chained to a SECOND violent verb ("find you and
// hurt you") it's a real compound threat, not a meetup, and doesn't need
// an "I'll" gate either since the second verb is what makes it unambiguous.
test('a compound "find you and [hurt/kill/etc] you" threat still blocks', () => {
  assert.equal(screenMessage('i will find you and hurt you if this continues').action, 'block');
  assert.equal(screenMessage('i will find you and hurt you if you do not vote for me thanks').action, 'block');
});

// detectThreatSignal is the broader, paging-only detector (never used to
// block/delete) — services/checkinSafety.js relies on it to catch
// THIRD-PARTY threat reports in a check-in note ("my roommate said he will
// hurt you"), which have no first-person "I'll" for screenMessage's
// stricter, block-worthy rule to gate on.
test('detectThreatSignal catches a third-person threat report screenMessage would miss', () => {
  const note = 'my roommate said he will hurt you if we stay and it scared me';
  assert.equal(detectThreatSignal(note), true);
  // screenMessage's BLOCK_RULES are intentionally stricter (would delete a
  // real message) — this is exactly why the note-paging path needs the
  // separate, broader detector rather than reusing screen.category.
  assert.notEqual(screenMessage(note).action, 'block');
});

test('detectThreatSignal does not fire on ordinary chat', () => {
  assert.equal(detectThreatSignal('hey! are you still looking for a place near campus?'), false);
  assert.equal(detectThreatSignal(''), false);
});

test('flags (does not block) a gift-card scam signal', () => {
  const r = screenMessage('can you just send a gift card for the deposit');
  assert.equal(r.action, 'flag');
  assert.equal(r.category, 'scam');
});

test('flags a crypto scam signal', () => {
  assert.equal(screenMessage('pay the deposit in bitcoin').action, 'flag');
});

test('empty / whitespace is allowed', () => {
  assert.equal(screenMessage('').action, 'allow');
  assert.equal(screenMessage('   ').action, 'allow');
});
