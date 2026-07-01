// ═══════════════════════════════════════════════════════════════════════════
//  The analyst job — orchestrates the outcome-learning loop end to end:
//    read outcomes + quiz answers → label each pair → run the regularized stats
//    (global + per-school) → LLM plain-English summary → enqueue PENDING
//    proposals for human approval.
//
//  Runs on the existing scheduler and on a manual bot endpoint. Inert until data
//  accrues: below the readiness gate it enqueues NOTHING and reports "not ready"
//  — scoring stays on today's expert weights, bit-for-bit. It only ever PROPOSES;
//  the commit stays human-gated (weightProposalStore + routes/weightLearning).
// ═══════════════════════════════════════════════════════════════════════════

const pool = require('../db/pool');
const { QUESTION_POINTS, OPTION_COUNTS, WEIGHTS_VERSION } = require('./scoring');
const wl = require('./weightLearning');
const store = require('./weightProposalStore');
const analyst = require('./analystSummary');

// A per-school layer needs its own body of outcomes before it may deviate from
// the global weights (Phase 3 gate). Schools below this contribute only to the
// global proposal and fall back to global weights at match time.
const SCHOOL_ENQUEUE_MIN = wl.MIN_N_SCHOOL;

// Read all outcomes + the two users' answers/schools, and build the labeled
// pairs + answersByUser the stats need. Pure DB read; soft-fails to empty.
async function buildLabeledData() {
  let outcomeRows = [];
  try {
    const r = await pool.query(
      `SELECT LEAST(reporter_id, other_user_id) AS a,
              GREATEST(reporter_id, other_user_id) AS b,
              outcome, details
         FROM match_outcomes`,
    );
    outcomeRows = r.rows;
  } catch (e) {
    console.warn('[weight-analyst] outcomes read soft-fail:', e.message);
    return { pairs: [], answersByUser: {}, schoolByUser: {} };
  }

  // Group every outcome row by unordered pair.
  const byPair = new Map();
  for (const row of outcomeRows) {
    const key = `${row.a}|${row.b}`;
    if (!byPair.has(key)) byPair.set(key, { a: row.a, b: row.b, rows: [] });
    byPair.get(key).rows.push({ outcome: row.outcome, details: row.details });
  }

  // Fetch answers + school for every user that appears in a pair.
  const userIds = [...new Set(outcomeRows.flatMap((r) => [r.a, r.b]))];
  const answersByUser = {}, schoolByUser = {};
  if (userIds.length) {
    try {
      const r = await pool.query(
        `SELECT u.id, u.school, qa.answers
           FROM users u LEFT JOIN quiz_answers qa ON qa.user_id = u.id
          WHERE u.id = ANY($1::uuid[])`,
        [userIds],
      );
      for (const row of r.rows) {
        answersByUser[row.id] = row.answers || {};
        schoolByUser[row.id] = row.school || null;
      }
    } catch (e) {
      console.warn('[weight-analyst] answers read soft-fail:', e.message);
    }
  }

  // Label each pair; keep only decided ones (worked/failed). Tag a pair's school
  // only when BOTH roommates are at the same school (a clean per-school signal).
  const pairs = [];
  for (const { a, b, rows } of byPair.values()) {
    const label = wl.labelPair(rows);
    if (!label) continue; // too-early / unknown — excluded from training
    const sameSchool = schoolByUser[a] && schoolByUser[a] === schoolByUser[b] ? schoolByUser[a] : null;
    pairs.push({ label, aId: a, bId: b, school: sameSchool });
  }
  return { pairs, answersByUser, schoolByUser };
}

// Compute the global + per-school proposals. Returns illustrative results even
// when not ready (for the manual endpoint); does NOT enqueue.
async function computeProposals() {
  const { pairs, answersByUser } = await buildLabeledData();

  const global = wl.propose({
    labeledPairs: pairs,
    answersByUser,
    priorWeights: QUESTION_POINTS,
    optionCounts: OPTION_COUNTS,
    scope: 'global',
  });

  // Per-school: shrink toward the GLOBAL (live) weights. Only build a layer for
  // schools with enough decided pairs to be worth a human's attention.
  const bySchool = new Map();
  for (const p of pairs) if (p.school) {
    if (!bySchool.has(p.school)) bySchool.set(p.school, []);
    bySchool.get(p.school).push(p);
  }
  const schools = [];
  for (const [school, schoolPairs] of bySchool) {
    if (schoolPairs.length < SCHOOL_ENQUEUE_MIN) continue;
    schools.push(wl.propose({
      labeledPairs: schoolPairs,
      answersByUser,
      priorWeights: QUESTION_POINTS, // the live global weights
      optionCounts: OPTION_COUNTS,
      scope: `school:${school}`,
    }));
  }

  return { global, schools, decidedTotal: pairs.length };
}

// Full run: compute, summarize, and enqueue every READY proposal. Non-ready
// proposals are reported but not queued (no pre-data noise). Best-effort.
async function runAnalyst({ enqueue = true } = {}) {
  const { global, schools, decidedTotal } = await computeProposals();
  const candidates = [global, ...schools].filter((p) => p.ready);
  const enqueued = [];

  if (enqueue) {
    for (const proposal of candidates) {
      const { summary, source } = await analyst.summarize(proposal);
      const row = await store.insertIfNew(proposal, {
        summary, summarySrc: source, baseVersion: WEIGHTS_VERSION,
      });
      if (row) enqueued.push({ id: row.id, scope: row.scope, decided: row.decided });
    }
  }

  return {
    ranAt: null, // stamped by the caller (Date.now unavailable in some contexts)
    decidedTotal,
    baseVersion: WEIGHTS_VERSION,
    global: { ready: global.ready, decided: global.decided, minN: global.minN, anomalies: global.anomalies.length },
    schools: schools.map((s) => ({ scope: s.scope, ready: s.ready, decided: s.decided, minN: s.minN })),
    enqueued,
    note: candidates.length
      ? `${enqueued.length} new proposal(s) queued for human approval.`
      : 'Not ready — no proposals queued. Scoring unchanged (today, bit-for-bit).',
  };
}

module.exports = { buildLabeledData, computeProposals, runAnalyst, SCHOOL_ENQUEUE_MIN };
