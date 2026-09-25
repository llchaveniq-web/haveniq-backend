// A budget the student never chose must not leave the server as a fact.
//
// users.budget_min / budget_max are DEFAULT 500 / DEFAULT 2000 and signup
// inserts neither (src/routes/auth.js), so every account that has ever existed
// carries 500-2000 whether or not anyone touched it. The app derived hasBudget
// as "budgetMin != null && budgetMax != null", which a default satisfies, so it
// was TRUE for every user alive -- and components/LivingFacts.tsx, which says
// "a budget shows only if that student really set one (hasBudget)", showed
// $500 to $2,000 for everyone. types/index.ts warns against exactly this
// derivation in its own words and the code did it anyway.
//
// The DTO now withholds an unanswered range, the same way it has always
// withheld an unanswered move-in.
// Requiring the route module pulls in the auth config, which refuses to load
// without a secret. Same preamble as matches.buildDto.test.js next door.
process.env.JWT_SECRET = process.env.JWT_SECRET
  || require('crypto').randomBytes(48).toString('hex');

const test = require('node:test');
const assert = require('node:assert');
const { budgetIsAnswer, buildMatchDTO } = require('./matches');

const row = (over = {}) => ({ budget_min: 500, budget_max: 2000, budget_set_at: null, ...over });

test('the schema default is not an answer', () => {
  assert.equal(budgetIsAnswer(row()), false);
});

test('a range the student picked is an answer, stamped or not', () => {
  // Stamped: the exact signal, for everything written from now on.
  assert.equal(budgetIsAnswer(row({ budget_min: 800, budget_max: 1200, budget_set_at: new Date() })), true);
  // Unstamped but non-default: budget_set_at is deliberately not backfilled, so
  // every row is unstamped on the day this ships. Keying on the stamp ALONE
  // would take away every budget that had really been set.
  assert.equal(budgetIsAnswer(row({ budget_min: 800, budget_max: 1200 })), true);
});

test('500 to 2000 counts once the student says so', () => {
  // The case the heuristic alone can never see, and the reason the stamp is
  // worth having at all: someone whose real answer happens to be the default.
  assert.equal(budgetIsAnswer(row({ budget_set_at: new Date() })), true);
});

test('a half-filled range is not an answer', () => {
  assert.equal(budgetIsAnswer(row({ budget_min: null })), false);
  assert.equal(budgetIsAnswer(row({ budget_max: null })), false);
});

// The helper being right does not prove the DTO uses it. matches.buildDto.test.js
// builds its row with 800/1400, a real budget, so it passes under the old rule
// and the new one alike and cannot see this change at all. These two go through
// buildMatchDTO itself.
test('the DTO withholds a default budget', () => {
  const dto = buildMatchDTO({
    id: 'u1', first_name: 'Sam', last_name: 'T', score: '80',
    budget_min: 500, budget_max: 2000, budget_set_at: null,
  });
  assert.equal(dto.budgetMin, null);
  assert.equal(dto.budgetMax, null);
});

test('the DTO sends a budget the student chose', () => {
  const dto = buildMatchDTO({
    id: 'u1', first_name: 'Sam', last_name: 'T', score: '80',
    budget_min: 800, budget_max: 1200, budget_set_at: null,
  });
  assert.equal(dto.budgetMin, 800);
  assert.equal(dto.budgetMax, 1200);
});
