const { isResearchUser } = require('../utils/founders');

// Research-only gate for /research/*. Mirrors requireFounder's shape (and its
// 403 body). Must run AFTER requireAuth, which populates req.user.
//
// This is the one gate that guards a dataset which deliberately joins BOTH
// sides of a pairing. A normal user token must never reach it: one roommate's
// `signal` events (their pulse) are private to them, and the product enforces
// that everywhere else. Founder ⊆ researcher; fails closed when the env is unset.
function requireResearch(req, res, next) {
  if (!isResearchUser(req.user)) {
    return res.status(403).json({ error: 'Research access only' });
  }
  next();
}

module.exports = { requireResearch };
