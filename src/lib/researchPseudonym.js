// De-identification for the research export surface (routes/research.js,
// and routes/pairs.js's GET /:pairId/timeline — the only two places in the
// app that return BOTH sides of a real pairing to a human). Previously
// these returned raw user_id/pair_id values; since a research-role account
// is still an ordinary authenticated user (see utils/founders.js —
// requireResearch grants a role, not a different account type), it could
// trivially resolve either person's identity (name, school, photo) via the
// normal GET /users/:id lookup every user already has. Pseudonyms are
// STABLE (same real id -> same pseudonym everywhere) so an analyst can
// still track one person or one pair across their full history —
// de-identified, not de-linked.
//
// This only pseudonymizes what's SENT to a human via these two research
// routes. The underlying pair_events store (services/pairEvents.js) keeps
// real ids — that's deliberate, matching its own "the dataset's value is
// its HONESTY" framing; this is an export-boundary transform, not a
// storage decision, and the audit log (services/auditLog.js) that now
// covers both routes records the REAL pairKey a researcher queried, since
// an investigation into misuse needs the real identity even though the
// export response itself doesn't carry one.

const crypto = require('crypto');

function secret() {
  // A dev-only fallback keeps local/test runs working without extra setup;
  // production MUST set a real secret via env or pseudonyms would be
  // reversible by anyone who read this (public) source file.
  return process.env.RESEARCH_PSEUDONYM_SECRET || 'dev-only-insecure-pseudonym-secret-change-me';
}

function pseudoId(realId) {
  return crypto.createHmac('sha256', secret()).update(String(realId)).digest('hex').slice(0, 16);
}

// pairKey is "userA:userB" sorted — pseudonymize each side, then re-sort so
// the SAME pair always produces the same pseudonymized key regardless of
// which real id happened to sort first before hashing.
function pseudoPairKey(pairKey) {
  return String(pairKey).split(':').map(pseudoId).sort().join(':');
}

function pseudonymizeEvent(e) {
  return {
    ...e,
    userId: pseudoId(e.userId),
    pairId: pseudoId(e.pairId),
    pairKey: pseudoPairKey(e.pairKey),
  };
}

module.exports = { pseudoId, pseudoPairKey, pseudonymizeEvent };
