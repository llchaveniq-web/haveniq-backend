// Single source of truth for columns on the `users` row that must NEVER leave
// the backend in an API response or a data export.
//
// Why centralized: PATCH /users/me returned `RETURNING *` verbatim and the
// data-export snapshot copy went out unredacted — two separate paths each
// leaking totp_secret (which, in a response, fully defeats 2FA). A per-route
// hand-picked strip is exactly how they diverged. Every serializer that can
// emit a users row should route through here so there is one list to maintain.
//
// Add any newly-added secret/internal column to this list.
const SENSITIVE_USER_KEYS = Object.freeze([
  'password_hash',        // defensive: app is passwordless today, but never ship it
  'totp_secret',          // shipping this defeats the 2FA second factor
  'totp_recovery_codes',  // bcrypt hashes — still must not leave the server
  'stripe_customer_id',   // billing linkage — internal
  'tokens_valid_after',   // session-revocation cutoff — internal
  'ban_reason',           // moderation data — internal
  'parent_email',         // third party's PII
]);

// Shallow copy of a users row (or any object) with all sensitive keys removed.
// Returns the input unchanged if it isn't a plain object.
function stripSensitiveUser(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = { ...row };
  for (const k of SENSITIVE_USER_KEYS) delete out[k];
  return out;
}

module.exports = { SENSITIVE_USER_KEYS, stripSensitiveUser };
