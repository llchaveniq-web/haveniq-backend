// ═══════════════════════════════════════════════════════════════════════════
//  Review queue + change log for learned weights — the human gate.
//
//  The analyst job PROPOSES weights (weightLearning.js) and stores them here as
//  PENDING. A human (founder) approves or rejects; approval is LOGGED with the
//  sample + fingerprint. Approval does NOT edit the live model — it records the
//  decision and returns the exact weight map + a suggested version stamp for the
//  human to commit into scoring.js AND stores/quizStore.ts together (the one
//  hard stop stays a reviewed code commit, never a silent DB override).
//
//  Every function soft-fails (returns null / [] and logs) if the DB is
//  unavailable, matching the rest of the codebase — the learning loop must never
//  take down a request path.
// ═══════════════════════════════════════════════════════════════════════════

const pool = require('../db/pool');

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weight_proposals (
      id           BIGSERIAL PRIMARY KEY,
      scope        TEXT NOT NULL,                 -- 'global' | 'school:<name>'
      ready        BOOLEAN NOT NULL,
      decided      INT NOT NULL,
      min_n        INT NOT NULL,
      fingerprint  TEXT NOT NULL,
      proposed     JSONB NOT NULL,                -- { qid: weight }
      signals      JSONB NOT NULL,
      anomalies    JSONB NOT NULL,
      summary      TEXT,
      summary_src  TEXT,
      base_version TEXT,                          -- WEIGHTS_VERSION at proposal time
      status       TEXT NOT NULL DEFAULT 'pending',
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      reviewed_at  TIMESTAMPTZ,
      reviewed_by  UUID,
      review_note  TEXT
    );
    -- At most one PENDING proposal per (scope, fingerprint): the analyst job
    -- reruns on a schedule and would otherwise spam identical proposals.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_weight_proposals_pending
      ON weight_proposals(scope, fingerprint) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_weight_proposals_status
      ON weight_proposals(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS weight_change_log (
      id           BIGSERIAL PRIMARY KEY,
      proposal_id  BIGINT,
      scope        TEXT NOT NULL,
      from_version TEXT,
      to_version   TEXT,
      fingerprint  TEXT NOT NULL,
      weights      JSONB NOT NULL,
      decided      INT,
      approved_by  UUID,
      approved_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch((e) => console.error('[weight-proposals] ensure tables:', e.message));
}

// Insert a proposal if no identical pending one already exists (dedup via the
// partial unique index → ON CONFLICT DO NOTHING). Returns the row, or null if
// it was a duplicate / the insert soft-failed.
async function insertIfNew(proposal, { summary, summarySrc, baseVersion } = {}) {
  await ensureTables();
  try {
    const { rows } = await pool.query(
      `INSERT INTO weight_proposals
         (scope, ready, decided, min_n, fingerprint, proposed, signals, anomalies, summary, summary_src, base_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (scope, fingerprint) WHERE status = 'pending' DO NOTHING
       RETURNING *`,
      [
        proposal.scope, proposal.ready, proposal.decided, proposal.minN, proposal.fingerprint,
        JSON.stringify(proposal.proposedWeights), JSON.stringify(proposal.signals),
        JSON.stringify(proposal.anomalies), summary || null, summarySrc || null, baseVersion || null,
      ],
    );
    return rows[0] || null;
  } catch (e) {
    console.error('[weight-proposals] insert failed:', e.message);
    return null;
  }
}

async function listPending(scope) {
  await ensureTables();
  try {
    const { rows } = scope
      ? await pool.query(`SELECT * FROM weight_proposals WHERE status='pending' AND scope=$1 ORDER BY created_at DESC LIMIT 100`, [scope])
      : await pool.query(`SELECT * FROM weight_proposals WHERE status='pending' ORDER BY created_at DESC LIMIT 100`);
    return rows;
  } catch (e) {
    console.error('[weight-proposals] list failed:', e.message);
    return [];
  }
}

async function getById(id) {
  await ensureTables();
  try {
    const { rows } = await pool.query(`SELECT * FROM weight_proposals WHERE id=$1`, [id]);
    return rows[0] || null;
  } catch (e) {
    console.error('[weight-proposals] get failed:', e.message);
    return null;
  }
}

// Human approval. Marks the proposal approved and writes the change log. Returns
// { proposal, changeLog, suggestedVersion, weights } for the human to commit —
// does NOT mutate scoring.js. Refuses to approve an unready (thin-cohort)
// proposal: readiness is a hard precondition, not a suggestion.
async function approve(id, { reviewerId, toVersion } = {}) {
  await ensureTables();
  try {
    const proposal = await getById(id);
    if (!proposal) return { ok: false, reason: 'not_found' };
    if (proposal.status !== 'pending') return { ok: false, reason: `already_${proposal.status}` };
    if (!proposal.ready) return { ok: false, reason: 'not_ready' };

    const suggestedVersion = toVersion
      || `v9-learned-${proposal.scope.replace(/[^a-z0-9]+/gi, '-')}-${proposal.id}`;

    await pool.query(`UPDATE weight_proposals SET status='approved', reviewed_at=NOW(), reviewed_by=$2 WHERE id=$1`,
      [id, reviewerId || null]);
    const { rows } = await pool.query(
      `INSERT INTO weight_change_log
         (proposal_id, scope, from_version, to_version, fingerprint, weights, decided, approved_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [proposal.id, proposal.scope, proposal.base_version, suggestedVersion,
       proposal.fingerprint, JSON.stringify(proposal.proposed), proposal.decided, reviewerId || null],
    );
    return {
      ok: true,
      proposal,
      changeLog: rows[0],
      suggestedVersion,
      weights: proposal.proposed,
      note: 'Approved + logged. Apply these weights to scoring.js AND stores/quizStore.ts, '
        + 'bump WEIGHTS_VERSION in BOTH to the suggestedVersion, then deploy. Nothing changed automatically.',
    };
  } catch (e) {
    console.error('[weight-proposals] approve failed:', e.message);
    return { ok: false, reason: 'error' };
  }
}

async function reject(id, { reviewerId, note } = {}) {
  await ensureTables();
  try {
    const { rows } = await pool.query(
      `UPDATE weight_proposals SET status='rejected', reviewed_at=NOW(), reviewed_by=$2, review_note=$3
        WHERE id=$1 AND status='pending' RETURNING id`,
      [id, reviewerId || null, note || null],
    );
    return { ok: rows.length > 0 };
  } catch (e) {
    console.error('[weight-proposals] reject failed:', e.message);
    return { ok: false };
  }
}

async function changeLog(limit = 50) {
  await ensureTables();
  try {
    const { rows } = await pool.query(`SELECT * FROM weight_change_log ORDER BY approved_at DESC LIMIT $1`, [limit]);
    return rows;
  } catch (e) {
    console.error('[weight-proposals] change log failed:', e.message);
    return [];
  }
}

module.exports = { ensureTables, insertIfNew, listPending, getById, approve, reject, changeLog };
