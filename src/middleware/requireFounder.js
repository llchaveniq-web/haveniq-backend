const { isFounder } = require('../utils/founders');

// Founder-only gate. Mirrors the 403 shape used across /admin and /admin/safety.
// Must run AFTER requireAuth (which populates req.user). Dependency-free of the
// DB, so it's importable + unit-testable on its own.
function requireFounder(req, res, next) {
  if (!isFounder(req.user && req.user.id)) {
    return res.status(403).json({ error: 'Founders only' });
  }
  next();
}

module.exports = { requireFounder };
