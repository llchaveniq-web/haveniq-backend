const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { askAssistant } = require('../services/knowledgeAgent');

// ── POST /assistant/ask ──────────────────────────────────────────────────
// "Ask HavenIQ" — answers a student's roommate / cohabitation question via
// the knowledge agent. One Anthropic call per question; the service is
// best-effort and never throws, so this route always returns a usable
// answer (a graceful fallback if the AI is unreachable).
router.post('/ask', requireAuth, async (req, res) => {
  try {
    const question = String((req.body && req.body.question) || '').trim();
    if (!question) return res.status(400).json({ error: 'question is required' });

    const { answer, source } = await askAssistant(question);
    res.json({ answer, source });
  } catch (err) {
    console.error('[assistant/ask] failed:', err.message);
    res.status(500).json({ error: 'Assistant is unavailable right now.' });
  }
});

module.exports = router;
