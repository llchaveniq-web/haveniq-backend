// Shared demo/test-account exclusion — the single source of truth for keeping
// non-real accounts out of real students' surfaces (feeds, signup stats) and out
// of LIFECYCLE/marketing email. Change the rule here and every caller stays
// correct. It is deliberately CONSERVATIVE ("when in doubt, exclude") because a
// demo/test account leaking into real lifecycle email has happened before, and a
// false-exclude of a genuine user is far cheaper than emailing a fake one.
//
// A column/address is a demo/test account iff it matches ANY of:
//   • a `.test` TLD          — reserved (RFC 2606), never a real address
//                              (covers the cohort-sim's @demo.haveniq.test)
//   • an `@demo.*` domain     — e.g. @demo.haveniq.app, @demo.haveniq.test
//   • an `@*-demo.*` domain   — e.g. @haveniq-demo.edu (the seeded cohort)
// (The two original explicit domains @haveniq-demo.edu / @demo.haveniq.app are
// subsumed by the -demo. / @demo. rules.) No real school domain looks like these.
//
// NOTE: this gates lifecycle/marketing + real-user-facing surfaces ONLY. It must
// NOT touch TRANSACTIONAL email (sign-in codes) — those go to any address,
// including a .test one, so a tester can still receive their login code.
//
// If a `users.is_demo` / `is_test` flag column is ever added, extend the SQL
// forms with `OR <alias>.is_demo = TRUE` (pass the alias) — none exists today.

// ILIKE (case-insensitive) patterns; `.` is a literal here, not a wildcard.
const DEMO_ILIKE_PATTERNS = ['%.test', '%@demo.%', '%-demo.%'];

// "this column IS a demo/test account" — a parenthesized SQL boolean.
function isDemo(col = 'email') {
  return `(${DEMO_ILIKE_PATTERNS.map((p) => `${col} ILIKE '${p}'`).join(' OR ')})`;
}

// "this column is NOT a demo/test account" — self-contained; safe to drop into
// any WHERE/AND context, e.g. `AND ${notDemo('u.email')}`.
//
// SIM-ONLY OVERRIDE: cohort-sim seeds a @demo.haveniq.test cohort and must be
// able to validate that the funnel + lifecycle actually COUNT/target them — but
// this filter deliberately excludes that exact domain (see the header, which
// calls it out by name). When SIM_INCLUDE_DEMO=1 — set ONLY by
// scripts/cohort-sim.js, which refuses to run against production — the exclusion
// is dropped so the sim can see its own seeded cohort. The env var is unset in
// every real deployment, so production analytics + lifecycle email stay
// demo-excluded, byte-for-byte identical.
function notDemo(col = 'email') {
  if (process.env.SIM_INCLUDE_DEMO === '1') return 'TRUE';
  return `(NOT ${isDemo(col)})`;
}

// JS-side equivalent for code paths that test an email in JavaScript (e.g. the
// lifecycle send loop skipping a demo recipient). Kept in lock-step with the SQL
// — including the SIM_INCLUDE_DEMO sim-only override above.
function isDemoEmail(email) {
  if (process.env.SIM_INCLUDE_DEMO === '1') return false;
  const e = String(email || '').toLowerCase();
  return /\.test$/.test(e) || e.includes('@demo.') || e.includes('-demo.');
}

module.exports = { notDemo, isDemo, isDemoEmail, DEMO_ILIKE_PATTERNS };
