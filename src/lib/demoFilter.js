// Shared demo/test-account SQL exclusion — the single source of truth.
//
// Demo / test accounts must NEVER appear to real students or count as a real
// signup. TWO flavors exist in production:
//   • @haveniq-demo.edu  — the seeded demo cohort (admin.js generator); the
//                          domain most of the codebase historically filtered on.
//   • @demo.haveniq.app  — the founder's manual test signups made through the
//                          real flow. They live only in the DB (no source
//                          reference), so a single-domain @haveniq-demo.edu
//                          filter MISSES them — which is how a test account
//                          leaked into real feeds, signup stats, and retention
//                          emails. Filtering only ONE domain is the bug this
//                          helper exists to prevent recurring: change the rule
//                          in ONE place, every surface stays correct.
//
// Pass the column reference (e.g. 'email' or 'u.email'). Returns a SQL
// boolean fragment — caller supplies the surrounding AND/WHERE.
function notDemo(col = 'email') {
  return `${col} NOT LIKE '%@haveniq-demo.edu' AND ${col} NOT LIKE '%@demo.haveniq.app'`;
}

module.exports = { notDemo };
