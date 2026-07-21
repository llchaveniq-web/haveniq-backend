/**
 * Numeric env-var reader with a default.
 *
 * Exists because `Number('')` is 0, not NaN. Three services had their own copy
 * of `(v, d) => Number.isFinite(Number(v)) ? Number(v) : d`, which returns the
 * default for an UNSET variable (undefined -> NaN) but returns 0 for one set to
 * an empty string — a state Railway produces when you clear a value in the UI
 * instead of deleting the variable.
 *
 * Zeroing these particular values is not a harmless default. They are safety
 * thresholds: WATCH_LIFECYCLE_COOLDOWN_DAYS=0 removes the 7-day cap that stops
 * a student being emailed on every run, and WATCH_DIGEST_MIN_COHORT=0 lets the
 * founder digest report on a cohort of one. A blank variable means "not
 * configured", so it must fall back to the guardrail, never to zero.
 *
 * Same drift lesson as the answers reader: one shared implementation, not a
 * copy per caller.
 */

/** Blank (unset / empty / whitespace) or non-numeric -> `d`. */
function envNum(v, d) {
  if (v === undefined || v === null) return d;
  if (typeof v === 'string' && v.trim() === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

module.exports = { envNum };
