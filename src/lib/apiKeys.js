// API-key crypto — single source of truth for generating + hashing developer
// API keys. The admin endpoints (routes/admin.js) use BOTH; a future developer-
// API auth middleware will reuse hashApiKey() to look up the incoming key by its
// sha256 (then constant-time compare + bump last_used_at). Keeping it here means
// the issue path and the verify path can never use different hashing.

const crypto = require('crypto');

// `hq_live_<32 url-safe random chars>`. 24 random bytes → 32 base64url chars, so
// the full secret is 40 chars (8-char prefix + 32 random). NEVER stored in plaintext.
function generateApiSecret() {
  return `hq_live_${crypto.randomBytes(24).toString('base64url')}`;
}

// Plain sha256 of the secret (no pepper — the secret itself is high-entropy).
// What gets stored, and what the future verify path will hash the incoming key to.
function hashApiKey(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

module.exports = { generateApiSecret, hashApiKey };
