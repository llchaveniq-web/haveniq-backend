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
// ── users.is_demo, and why the patterns above are not enough ────────────────
//
// Every rule above recognises a non-real account by the SHAPE of its address.
// That covers accounts the cohort simulator creates and nothing else.
//
// Production carried five students seeded by hand on plain @usc.edu addresses:
// alex.chen, sam.okafor, jordan.lee, priya.shah, maya.rodriguez, all created
// the same day, is_verified and quiz_completed both true. Out of eighteen rows.
// Nothing about those addresses is distinguishable from a real USC student, so
// every caller here counted them as real: match feeds, signup stats, and
// lifecycle marketing email.
//
// The email is what cost something. They were sent lifecycle mail, it hard
// bounced at USC, and Resend suppressed them. Twenty suppressed sends in a
// window of a hundred, every one to a seeded address. Repeated hard bounces at
// a university domain is what erodes a sending reputation, and that reputation
// decides whether real verification codes land at Microsoft-hosted schools.
//
// So: a FLAG, which is what this file's closing note has prescribed all along.
// Not another pattern. Any ILIKE broad enough to catch alex.chen@usc.edu would
// also catch a real student at USC, which is the whole problem restated.
//
// The alias is derived from the column rather than passed separately, so all
// nineteen existing call sites keep working unedited. Each of them passes
// either a bare `email` or an `alias.email` against the users table, verified
// one by one before this went in.

// ILIKE (case-insensitive) patterns; `.` is a literal here, not a wildcard.
const DEMO_ILIKE_PATTERNS = ['%.test', '%@demo.%', '%-demo.%'];

/**
 * The is_demo column that belongs with a given email column.
 * 'u.email' -> 'u.is_demo';  'email' -> 'is_demo'.
 */
function demoFlagFor(col) {
  const dot = String(col).lastIndexOf('.');
  return dot === -1 ? 'is_demo' : `${String(col).slice(0, dot)}.is_demo`;
}

// "this column IS a demo/test account" — a parenthesized SQL boolean.
function isDemo(col = 'email') {
  const shapes = DEMO_ILIKE_PATTERNS.map((p) => `${col} ILIKE '${p}'`);
  // COALESCE, because the column is NOT NULL today but a LEFT JOIN can still
  // produce a NULL for it, and `NOT (… OR NULL)` is NULL rather than true —
  // which would silently drop every real student from any query that used one.
  return `(${shapes.join(' OR ')} OR COALESCE(${demoFlagFor(col)}, FALSE) = TRUE)`;
}

// "this column is NOT a demo/test account" — self-contained; safe to drop into
// any WHERE/AND context, e.g. `AND ${notDemo('u.email')}`.
function notDemo(col = 'email') {
  return `(NOT ${isDemo(col)})`;
}

// JS-side equivalent for code paths that test an email in JavaScript (e.g. the
// lifecycle send loop skipping a demo recipient). Kept in lock-step with the
// SQL PATTERNS.
//
// It cannot see is_demo, and deliberately does not pretend to. All it receives
// is a string, and an address flagged by hand is by definition one this
// function cannot recognise: that is why the column exists. Every caller is a
// second line of defence behind a query that already applied notDemo(), which
// now does check the flag, so the gate is intact. Do not "fix" this by
// widening the patterns to cover a flagged address, because no pattern can
// separate alex.chen@usc.edu from a real student at USC.
//
// A caller that holds the whole row and wants both should test
// `row.is_demo || isDemoEmail(row.email)` and make sure its query actually
// SELECTs the column.
function isDemoEmail(email) {
  const e = String(email || '').toLowerCase();
  return /\.test$/.test(e) || e.includes('@demo.') || e.includes('-demo.');
}

module.exports = { notDemo, isDemo, isDemoEmail, demoFlagFor, DEMO_ILIKE_PATTERNS };
