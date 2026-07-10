'use strict';

// Conservative viability pre-filter for the match feed (matching-v10 P1).
//
// A high compatibility score is noise if two people can't actually share a
// lease. We drop candidates on HARD logistics conflicts BEFORE ranking — but
// only when both sides have real, conflicting data. Missing/unknown/default
// data always passes. The pool is thin (~30 users/campus), so over-filtering
// is the real risk; every rule here fails OPEN.

const THIN_POOL = 5;            // cold-start fallback threshold (existing rule)
const MOVE_IN_WINDOW_DAYS = 45; // "same term" tolerance
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

// move_in_timeline is free-ish TEXT: 'N months', 'Flexible', or NULL.
// 'Flexible' and unparseable/NULL → null (unknown → aligns with anyone).
function moveInDays(s) {
  if (typeof s !== 'string') return null;
  if (/flex/i.test(s)) return null;
  const m = s.match(/(\d+)\s*month/i);
  return m ? parseInt(m[1], 10) * 30 : null;
}

// Conflict = both concrete AND more than the window apart (different terms).
function moveInConflict(a, b) {
  const da = moveInDays(a.move_in_timeline);
  const db = moveInDays(b.move_in_timeline);
  if (da == null || db == null) return false;
  return Math.abs(da - db) > MOVE_IN_WINDOW_DAYS;
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
  MOVE_IN_WINDOW_DAYS,
  hasRealBudget,
  budgetsConflict,
  moveInDays,
  moveInConflict,
  isViable,
  applyCampusRanking,
};
