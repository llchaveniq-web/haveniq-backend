const { test } = require('node:test');
const assert = require('node:assert');
const { isModeratorUser, isFounderUser } = require('./founders');

function clearRoleEnv() {
  delete process.env.MODERATOR_EMAILS;
  delete process.env.MODERATOR_USER_IDS;
  delete process.env.FOUNDER_EMAILS;
  delete process.env.FOUNDER_USER_IDS;
}

test('founder is ALWAYS a moderator (founder ⊆ moderator)', () => {
  clearRoleEnv();
  process.env.FOUNDER_EMAILS = 'boss@haveniq.org';
  const founder = { id: 'f1', email: 'boss@haveniq.org' };
  assert.strictEqual(isFounderUser(founder), true);
  assert.strictEqual(isModeratorUser(founder), true);
  clearRoleEnv();
});

test('a random authenticated user is NOT a moderator', () => {
  clearRoleEnv();
  assert.strictEqual(isModeratorUser({ id: 'nope', email: 'someone@school.edu' }), false);
  assert.strictEqual(isModeratorUser(null), false);
  assert.strictEqual(isModeratorUser(undefined), false);
});

test('MODERATOR_EMAILS grants moderator access (case-insensitive), and ONLY those', () => {
  clearRoleEnv();
  process.env.MODERATOR_EMAILS = 'Helper@School.edu, second@x.edu';
  assert.strictEqual(isModeratorUser({ id: 'h', email: 'helper@school.edu' }), true);
  assert.strictEqual(isModeratorUser({ id: 'h', email: 'HELPER@SCHOOL.EDU' }), true);
  assert.strictEqual(isModeratorUser({ id: 's', email: 'second@x.edu' }), true);
  assert.strictEqual(isModeratorUser({ id: 'z', email: 'notlisted@x.edu' }), false, 'a non-listed user must NOT gain access');
  clearRoleEnv();
});

test('MODERATOR_USER_IDS grants moderator access by id', () => {
  clearRoleEnv();
  process.env.MODERATOR_USER_IDS = 'uuid-123, uuid-456';
  assert.strictEqual(isModeratorUser({ id: 'uuid-123', email: 'a@b.edu' }), true);
  assert.strictEqual(isModeratorUser({ id: 'uuid-999', email: 'a@b.edu' }), false);
  clearRoleEnv();
});

test('a moderator is NOT automatically a founder (roles are distinct)', () => {
  clearRoleEnv();
  process.env.MODERATOR_EMAILS = 'helper@school.edu';
  const mod = { id: 'h', email: 'helper@school.edu' };
  assert.strictEqual(isModeratorUser(mod), true);
  assert.strictEqual(isFounderUser(mod), false, 'moderator must not gain founder-only ops access');
  clearRoleEnv();
});
