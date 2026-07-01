// Time-series of the learning loop's health: each scheduled calibration
// recompute records one row (sample size, Brier, AUC, monotonic?, headline
// multiple). The admin metrics route reads current + recent history to answer
// "is the engine improving?". Soft-fails to empty — never blocks a request.
const pool = require('../db/pool');

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS learning_snapshots (
      id             BIGSERIAL PRIMARY KEY,
      total_sample   INT NOT NULL,
      brier          DOUBLE PRECISION,
      auc            DOUBLE PRECISION,
      monotonic      BOOLEAN,
      headline_mult  DOUBLE PRECISION,
      bands          JSONB,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_learning_snapshots_time
      ON learning_snapshots(created_at DESC);
  `).catch((e) => console.error('[learning-snapshots] ensure table:', e.message));
}

async function record({ totalSample, brier, auc, monotonic, headlineMult, bands }) {
  await ensureTable();
  try {
    await pool.query(
      `INSERT INTO learning_snapshots (total_sample, brier, auc, monotonic, headline_mult, bands)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [totalSample | 0, brier ?? null, auc ?? null, monotonic ?? null, headlineMult ?? null,
       bands ? JSON.stringify(bands) : null],
    );
    return true;
  } catch (e) {
    console.error('[learning-snapshots] record failed:', e.message);
    return false;
  }
}

async function recent(limit = 30) {
  await ensureTable();
  try {
    const { rows } = await pool.query(
      `SELECT total_sample, brier, auc, monotonic, headline_mult, created_at
         FROM learning_snapshots ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  } catch (e) {
    console.error('[learning-snapshots] recent failed:', e.message);
    return [];
  }
}

module.exports = { ensureTable, record, recent };
