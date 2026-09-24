'use strict';

// Conservative viability pre-filter for the match feed (matching-v10 P1).
//
// A high compatibility score is noise if two people can't actually share a
// lease. We drop candidates on HARD logistics conflicts BEFORE ranking — but
// only when both sides have real, conflicting data. Missing/unknown/default
// data always passes. The pool is thin (~30 users/campus), so over-filtering
// is the real risk; every rule here fails OPEN.

const THIN_POOL = 5;            // cold-start fallback threshold (existing rule)
const DEFAULT_BUDGET_MIN = 500; // schema.sql users.budget_min DEFAULT
const DEFAULT_BUDGET_MAX = 2000; // schema.sql users.budget_max DEFAULT

// A budget counts as "real" only if it isn't the exact schema default pair.
// The client AND the DB default an unset budget to 500–2000, so we can't tell a
// genuine 500–2000 from "never set" — treat that pair as unknown and never
// exclude on it. Any other value = the user moved a slider, so it's real.
function hasRealBudget(min, max) {
  if (min == null || max == null) return false;
  const lo = Number(min), hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
  if (lo === DEFAULT_BUDGET_MIN && hi === DEFAULT_BUDGET_MAX) return false;
  return true;
}

// Ranges overlap iff aMax >= bMin AND bMax >= aMin. Conflict = both real + no
// overlap (e.g. someone capped at $800 vs someone starting at $1500).
function budgetsConflict(a, b) {
  if (!hasRealBudget(a.budget_min, a.budget_max)) return false;
  if (!hasRealBudget(b.budget_min, b.budget_max)) return false;
  const aMin = Number(a.budget_min), aMax = Number(a.budget_max);
  const bMin = Number(b.budget_min), bMax = Number(b.budget_max);
  return !(aMax >= bMin && bMax >= aMin);
}

// Move-in timing.
//
// This filter did nothing for anyone. It parsed move_in_timeline as "N months"
// and measured the gap in days, which was the right rule for a format the app
// stopped sending. The picker (app constants/moveIn.ts) offers, and this
// server's own validator accepts, exactly five values: this_month, 1-3_months,
// spring_semester, fall_semester, flexible. Not one of them matches the
// N-months pattern, and 1-3_months misses it because an underscore is not
// whitespace, so the parser returned null every time and moveInConflict
// returned false for all 36 ordered pairs of values that can exist. Someone
// moving in this month and someone moving in next fall were fully viable to
// each other, at any score.
//
// It is now the same rule the app already applies on the client in
// moveInCompatible(): unknown or flexible never rules anyone out, identical
// timings agree, "this month" and "within three months" are one window, and a
// semester start is its own. Like lib/pairAgreement.js this is a deliberate
// mirror of an app file, so a change to constants/moveIn.ts is a change here.

// The five the picker offers and routes/users.js accepts.
const MOVE_IN_VALUES = new Set(['this_month', '1-3_months', 'spring_semester', 'fall_semester', 'flexible']);

// "Soon" is one window: this month and within three months overlap.
const MOVE_IN_SOON = new Set(['this_month', '1-3_months']);

/**
 * The student's real, concrete move-in, or null for anything that must not
 * exclude anyone.
 *
 * Gated on move_in_set_at, which PATCH /users/me stamps when a student actually
 * answers. A row without it carries a leftover from the old picker, which asked
 * lease LENGTH and wrote the answer into this column, and a leftover must never
 * rule a real person out of someone's feed. 'flexible' IS a real answer and
 * still returns null here, because it is compatible with everything.
 */
function realMoveIn(row) {
  if (!row || !row.move_in_set_at) return null;
  const v = row.move_in_timeline;
  if (typeof v !== 'string' || !MOVE_IN_VALUES.has(v)) return null;
  return v === 'flexible' ? null : v;
}

/** Does this student have a concrete move-in worth filtering on at all? */
function hasRealMoveIn(row) {
  return realMoveIn(row) != null;
}

// Conflict = both gave a concrete answer AND the two windows cannot meet.
function moveInConflict(a, b) {
  const ma = realMoveIn(a);
  const mb = realMoveIn(b);
  if (ma == null || mb == null) return false;      // fail open, as everything here does
  if (ma === mb) return false;
  return !(MOVE_IN_SOON.has(ma) && MOVE_IN_SOON.has(mb));
}

// Is `them` a viable roommate for `me` on hard logistics? Returns a reason so
// callers can log why a candidate was dropped.
function isViable(me, them) {
  if (budgetsConflict(me, them)) return { viable: false, reason: 'budget' };
  if (moveInConflict(me, them))  return { viable: false, reason: 'moveIn' };
  return { viable: true, reason: null };
}

// Campus preference: same-school candidates first; append cross-school ONLY
// when the same-school pool is below THIN_POOL (so a thin campus still gets a
// feed instead of an empty one). Input is assumed already score-ordered; this
// preserves that order within each group. No-op when the viewer's school is
// unknown (never strand a user by filtering on a null school).
function applyCampusRanking(rows, mySchool, thinPool = THIN_POOL) {
  if (!mySchool) return rows;
  const same = rows.filter(r => r.school === mySchool);
  const cross = rows.filter(r => r.school !== mySchool);
  return same.length >= thinPool ? same : same.concat(cross);
}

module.exports = {
  THIN_POOL,
  MOVE_IN_VALUES,
  MOVE_IN_SOON,
  hasRealBudget,
  budgetsConflict,
  realMoveIn,
  hasRealMoveIn,
  moveInConflict,
  isViable,
  applyCampusRanking,
};
