// Orchestrator tests for the autonomous lifecycle sender. Fake pool / email /
// alert — no DB, no network. Covers the guardrails that replace human approval:
// kill switch, circuit-breaker pause+page, autonomous send + audit log, cross-
// segment dedup, and the demo/consent belt. node --test.
const test = require('node:test');
const assert = require('node:assert');
const { runLifecycle } = require('./lifecycleSender');

// Fake pool routing on SQL fragments. Segment fixtures are configurable per test.
function makePool({ activeCount = 100, quiz = [], matches = [], invited = [] } = {}) {
  const inserts = { sends: [], runs: [] };
  const pool = {
    inserts,
    query: async (sql, params = []) => {
      if (sql.includes('CREATE TABLE')) return { rows: [] };
      if (sql.includes('COUNT(*)::int AS n')) return { rows: [{ n: activeCount }] };
      if (sql.includes('compatibility_scores')) return { rows: matches };
      if (sql.includes('referrals r WHERE')) return { rows: invited };
      if (sql.includes('quiz_answers qa')) return { rows: quiz }; // quiz_incomplete (NOT EXISTS quiz)
      if (sql.startsWith('\n    INSERT INTO lifecycle_sends') || sql.includes('INSERT INTO lifecycle_sends')) {
        inserts.sends.push({ userId: params[0], email: params[1], segment: params[2], template: params[3], status: params[4], error: params[5] });
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO lifecycle_runs')) {
        inserts.runs.push({ enabled: params[0], activeCount: params[1], threshold: params[2], planned: params[3], sent: params[4], failed: params[5], paused: params[6] });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return pool;
}

function makeSink() {
  const emails = [], alerts = [];
  return {
    emails, alerts,
    sendEmail: async (m) => { emails.push(m); },
    alert: async (info) => { alerts.push(info); },
  };
}

const U = (id, name) => ({ id, email: `${id}@school.edu`, first_name: name });

test('kill switch OFF → nothing sent, no tables touched', async () => {
  const pool = makePool({ quiz: [U('u1', 'A')] });
  const sink = makeSink();
  const r = await runLifecycle({ enabled: false, pool, sendEmail: sink.sendEmail, alert: sink.alert });
  assert.equal(r.enabled, false);
  assert.equal(r.skipped, 'disabled');
  assert.equal(sink.emails.length, 0);
  assert.equal(pool.inserts.sends.length, 0);
  assert.equal(pool.inserts.runs.length, 0);
});

test('normal run → sends autonomously, dedups across segments, logs every send', async () => {
  const pool = makePool({
    activeCount: 100,
    quiz:    [U('u1', 'A'), U('u2', 'B')],
    matches: [U('u1', 'A'), U('u3', 'C')],   // u1 also matches — must dedup to quiz_incomplete
    invited: [U('u2', 'B')],                 // u2 also — dedup
  });
  const sink = makeSink();
  const r = await runLifecycle({
    enabled: true, pool, sendEmail: sink.sendEmail, alert: sink.alert,
    config: { maxFraction: 0.5, minAbs: 10, hardCap: 2000, activeWindow: 30, cooldownDays: 7 },
  });
  assert.equal(r.paused, false);
  assert.equal(r.sent, 3);                         // u1, u2, u3 — once each
  assert.equal(sink.emails.length, 3);
  assert.equal(pool.inserts.sends.length, 3);
  assert.equal(pool.inserts.sends.every((s) => s.status === 'sent'), true);
  // u1 was emailed under the highest-priority segment.
  assert.equal(pool.inserts.sends.find((s) => s.userId === 'u1').segment, 'quiz_incomplete');
  assert.equal(sink.alerts.length, 0);             // no page on a normal run
  assert.equal(pool.inserts.runs[0].paused, false);
  assert.equal(pool.inserts.runs[0].sent, 3);
});

test('circuit breaker → PAUSES (no sends) and pages once', async () => {
  const pool = makePool({
    activeCount: 10,                               // cap = max(0, floor(10*0.10)) = 1
    quiz: [U('u1', 'A'), U('u2', 'B'), U('u3', 'C'), U('u4', 'D'), U('u5', 'E')],
  });
  const sink = makeSink();
  const r = await runLifecycle({
    enabled: true, pool, sendEmail: sink.sendEmail, alert: sink.alert,
    config: { maxFraction: 0.10, minAbs: 0, hardCap: 2000, activeWindow: 30, cooldownDays: 7 },
  });
  assert.equal(r.paused, true);
  assert.equal(r.planned, 5);
  assert.equal(r.threshold, 1);
  assert.equal(sink.emails.length, 0);             // FAIL SAFE — nothing sent
  assert.equal(sink.alerts.length, 1);             // paged a human once
  assert.equal(pool.inserts.sends.length, 0);
  assert.equal(pool.inserts.runs[0].paused, true); // the pause is audited
});

test('demo/consent belt: a demo address that slips through is not emailed', async () => {
  const pool = makePool({
    activeCount: 100,
    quiz: [U('u1', 'A'), { id: 'u2', email: 'test@demo.haveniq.app', first_name: 'Demo' }],
  });
  const sink = makeSink();
  const r = await runLifecycle({
    enabled: true, pool, sendEmail: sink.sendEmail, alert: sink.alert,
    config: { maxFraction: 0.9, minAbs: 10, hardCap: 2000, activeWindow: 30, cooldownDays: 7 },
  });
  assert.equal(sink.emails.length, 1);             // only the real user
  assert.equal(sink.emails[0].to, 'u1@school.edu');
});

test('a send failure is logged and does not abort the batch', async () => {
  const pool = makePool({ activeCount: 100, quiz: [U('u1', 'A'), U('u2', 'B')] });
  const emails = [];
  const sendEmail = async (m) => { emails.push(m); if (m.to === 'u1@school.edu') throw new Error('resend 500'); };
  const r = await runLifecycle({
    enabled: true, pool, sendEmail, alert: async () => {},
    config: { maxFraction: 0.9, minAbs: 10, hardCap: 2000, activeWindow: 30, cooldownDays: 7 },
  });
  assert.equal(r.sent, 1);
  assert.equal(r.failed, 1);
  assert.equal(pool.inserts.sends.length, 2);
  assert.equal(pool.inserts.sends.find((s) => s.userId === 'u1').status, 'failed');
});
