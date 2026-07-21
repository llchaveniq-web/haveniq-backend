// envNum — the shared numeric env reader. The case that matters is the BLANK
// variable: Number('') is 0, so the old per-service copies turned a cleared
// Railway value into a zeroed safety threshold rather than the default.
// node --test.
const test = require('node:test');
const assert = require('node:assert');
const { envNum } = require('./envNum');

test('unset falls back to the default', () => {
  assert.equal(envNum(undefined, 7), 7);
  assert.equal(envNum(null, 7), 7);
});

test('BLANK falls back to the default, NOT to 0', () => {
  // Railway produces this by clearing a value instead of deleting the variable.
  assert.equal(envNum('', 7), 7, "Number('') === 0 is the whole bug");
  assert.equal(envNum('   ', 7), 7);
});

test('a real value is read, including a deliberate 0', () => {
  assert.equal(envNum('0.02', 0.1), 0.02);
  assert.equal(envNum('30', 7), 30);
  assert.equal(envNum('0', 7), 0, 'an explicit 0 is a real configuration choice');
});

test('garbage falls back rather than becoming NaN', () => {
  assert.equal(envNum('soon', 7), 7);
  assert.equal(envNum({}, 7), 7);
});

test('the guardrails this protects keep their defaults when blank', () => {
  // The two that actually matter if they silently became 0.
  assert.equal(envNum('', 7), 7, 'lifecycle email cooldown stays 7 days');
  assert.equal(envNum('', 20), 20, 'digest minimum cohort stays 20');
});
