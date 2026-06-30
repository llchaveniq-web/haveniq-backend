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
// ILIKE (case-insensitive) so a mixed-case demo address can't slip past the
// filter; no real .edu is ever @haveniq-demo.edu / @demo.haveniq.app, so this
// can't false-exclude a genuine user.
function notDemo(col = 'email') {
  return `${col} NOT ILIKE '%@haveniq-demo.edu' AND ${col} NOT ILIKE '%@demo.haveniq.app'`;
}

// Positive form of the same rule — "this column IS a demo/test account".
// Use inside EXISTS / NOT EXISTS sub-selects where you're matching demo rows
// rather than excluding them. Keep this in lock-step with notDemo().
function isDemo(col = 'email') {
  return `(${col} ILIKE '%@haveniq-demo.edu' OR ${col} ILIKE '%@demo.haveniq.app')`;
}

// JS-side equivalent for code paths that test an email in JavaScript rather
// than SQL (e.g. skipping app emails to demo recipients). Same two-domain
// rule — added because scattered single-domain regexes were re-introducing
// the exact leak notDemo() was built to kill.
function isDemoEmail(email) {
  return /@(haveniq-demo\.edu|demo\.haveniq\.app)$/i.test(String(email || ''));
}

module.exports = { notDemo, isDemo, isDemoEmail };
