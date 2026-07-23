/**
 * Bot / internal auth — the module routes/{housing,matchOutcomes,profile,
 * weightLearning}.js have always tried to import.
 *
 * Those four files each contain:
 *     try { return require('../middleware/botAuth'); }
 *     catch { return { requireBotToken: <inline fallback> } }
 *
 * The file did not exist, so every one of them silently fell through to the
 * inline fallback — which compares the token with `got !== tok`, a plain string
 * comparison that leaks how much of the secret matched through response timing.
 * Only routes/botAdmin.js compared in constant time. Creating this module makes
 * all four resolve to the real, constant-time guard and turns their fallbacks
 * into dead code, with no edit to the route files themselves.
 *
 * `requireBotToken` is exported under its historical name so those imports keep
 * working; it is now the same single implementation as every other internal
 * endpoint (see requireInternalKey.js), which also accepts the newer
 * `X-Internal-Key: <INTERNAL_API_KEY>` header.
 */

const { requireInternalKey, hasValidInternalKey, constantTimeEqual } = require('./requireInternalKey');

module.exports = {
  // Historical name used by the existing route imports.
  requireBotToken: requireInternalKey,
  // Canonical name for anything new.
  requireInternalKey,
  hasValidInternalKey,
  constantTimeEqual,
};
