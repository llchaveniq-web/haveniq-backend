// Tests for first-line message moderation. Protects the "block egregious,
// flag scams, allow normal chat" contract so a regex edit can't silently
// start blocking real students or letting abuse through. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const { screenMessage } = require('./contentFilter');

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
