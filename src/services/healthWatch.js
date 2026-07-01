// ═══════════════════════════════════════════════════════════════════════════
//  Watch-loop self-reporting monitor.
//
//  A scheduled job polls /health (which already deep-checks Postgres and echoes
//  the deployed git SHA), records each result to a small rolling in-memory ring,
//  and pages a human — the `signal:backend_outage` alert — ONLY on a real
//  transition into an unhealthy state, debounced so a single blip never pages.
//  It clears the alert on recovery. GET /ops/health-history (admin) reads the
//  ring so status is self-reporting.
//
//  Honesty rules baked in:
//   - No data yet → empty history + status 'unknown'. Never a fabricated
//     "all green" when nothing has been observed.
//   - The human is paged only on the fire/clear TRANSITION (a decision), not on
//     every failing poll — the job does the watching.
//   - SHA-mismatch detection is only active when an EXPECTED sha is configured
//     (WATCH_EXPECTED_SHA); a same-process self-poll always echoes its own SHA,
//     so without an expected value we stay inert rather than false-page.
//
//  The core (classify + observe) is pure/injectable so the debounce + transition
//  logic is unit-tested without a network or timers.
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULTS = {
  capacity:         Number(process.env.WATCH_HISTORY_CAP)   || 200,  // rolling results kept
  failThreshold:    Number(process.env.WATCH_FAIL_THRESHOLD) || 3,   // consecutive fails before paging (debounce)
  recoverThreshold: Number(process.env.WATCH_RECOVER_THRESHOLD) || 2,// consecutive OKs before clearing
};

// Classify one poll result into healthy / not, with human-readable reasons.
//   raw = { httpStatus, body, latencyMs, error } where body is /health's JSON.
// expectedSha (optional): when set, a live SHA that differs is unhealthy
// (a stuck / rolled-back deploy). When null, SHA is informational only.
function classify(raw, expectedSha) {
  const reasons = [];
  const body = raw && raw.body;
  const sha = body && body.commit ? String(body.commit) : null;
  const db = body && body.db ? String(body.db) : null;

  if (raw && raw.error) reasons.push(`unreachable:${raw.error}`);
  if (!raw || raw.httpStatus !== 200) reasons.push(`http_${(raw && raw.httpStatus) || 'none'}`);
  if (db !== 'up') reasons.push(db ? `db_${db}` : 'db_unknown');
  if (expectedSha && sha && sha !== expectedSha) reasons.push(`sha_mismatch:${sha}!=${expectedSha}`);

  return {
    healthy: reasons.length === 0,
    reasons,
    sha,
    db,
    httpStatus: (raw && raw.httpStatus) || null,
    latencyMs: raw && Number.isFinite(raw.latencyMs) ? raw.latencyMs : null,
  };
}

// A watcher instance: rolling ring + debounced transition state machine.
// onFire / onClear are called ONLY on a state transition (the page / the
// all-clear). Everything is injectable for tests (clock, alert sinks).
function createWatcher(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const ring = [];
  let alertActive = false;
  let consecutiveFail = 0;
  let consecutiveOk = 0;
  let lastTransitionAt = null;

  const push = (record) => {
    ring.push(record);
    if (ring.length > cfg.capacity) ring.shift();
  };

  // Feed one classified result through the debounce; returns 'fire' | 'clear' |
  // null (the transition, if any). Records the result either way.
  function observe(classified, at) {
    const ts = at || new Date().toISOString();
    const record = { timestamp: ts, ...classified };
    push(record);

    let transition = null;
    if (classified.healthy) {
      consecutiveOk += 1;
      consecutiveFail = 0;
      if (alertActive && consecutiveOk >= cfg.recoverThreshold) {
        alertActive = false;
        lastTransitionAt = ts;
        transition = 'clear';
      }
    } else {
      consecutiveFail += 1;
      consecutiveOk = 0;
      if (!alertActive && consecutiveFail >= cfg.failThreshold) {
        alertActive = true;
        lastTransitionAt = ts;
        transition = 'fire';
      }
    }

    if (transition === 'fire' && typeof cfg.onFire === 'function') {
      Promise.resolve(cfg.onFire(record, { consecutiveFail })).catch(() => {});
    } else if (transition === 'clear' && typeof cfg.onClear === 'function') {
      Promise.resolve(cfg.onClear(record, { consecutiveOk })).catch(() => {});
    }
    return transition;
  }

  // Current self-reported status. 'unknown' until the first observation — the
  // honest answer when nothing has been watched yet (never a fake "healthy").
  function status() {
    if (ring.length === 0) {
      return { state: 'unknown', alertActive: false, observations: 0, lastChecked: null };
    }
    const last = ring[ring.length - 1];
    return {
      state: alertActive ? 'unhealthy' : (last.healthy ? 'healthy' : 'degraded'),
      alertActive,
      observations: ring.length,
      lastChecked: last.timestamp,
      lastSha: last.sha,
      lastLatencyMs: last.latencyMs,
      consecutiveFail,
      consecutiveOk,
      lastTransitionAt,
    };
  }

  // Most-recent-first slice of the ring.
  function history(limit) {
    const n = Number.isFinite(limit) ? limit : cfg.capacity;
    return ring.slice(-n).reverse();
  }

  return { observe, status, history, config: cfg, _ring: ring };
}

module.exports = { classify, createWatcher, DEFAULTS };
