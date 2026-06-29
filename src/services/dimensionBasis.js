// ─── Dimension basis (backend, deep-matching #2) ────────────────────────────
//
// Mirrors app/utils/dimensionBasis.ts. Today scoring.js scores every question
// through ONE fixed curve over |a−b| — it assumes "similar is always good,
// linearly." That's wrong for complementary dimensions (chore initiation,
// boundaries: an initiator + a responder beat two-of-a-kind) and can't express
// directional/threshold effects (neat × messy is bad AND asymmetric — the tidier
// roommate eats the cost).
//
// This widens each dimension's contribution from the single scalar |a−b| to a
// 5-feature BASIS computed from the two normalized answers a,b ∈ [0,1]:
//
//     dist = |a−b|   mean = (a+b)/2   min = min(a,b)   max = max(a,b)   prod = a·b
//
// A per-dimension logistic is fit on real pairing outcomes; the recovered signs
// name the shape automatically:
//     β_dist ≪ 0  → similarity (today)
//     β_dist  > 0 → complementarity
//     β_max  ≪ 0  → directional (the worse side drives the outcome)
//
// SAFETY (non-negotiable): cold-start is dist-only. With no learned shape the
// scorer is today's diffScore, bit-for-bit (see scoring.js). A learned shape is
// applied ONLY where a held-out gate says it beats the dist-only baseline on
// real "did it work?" outcomes — never by default. Complementarity is a finding,
// not an assertion.
//
// Pure, deterministic, dependency-free.

// 'conv' (deep-matching #6) is the trajectory CONVERGENCE rate: + when the two
// users' habits are closing the gap on this dimension, − when widening, 0 when
// neither is moving (cold-start). It composes as just one more basis column the
// #2 gate can weight or zero.
const BASIS_FNS = ['dist', 'mean', 'min', 'max', 'prod', 'conv'];
const EPS = 1e-12;
const isFin = (x) => typeof x === 'number' && Number.isFinite(x);
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * The basis features from a normalized answer pair a,b ∈ [0,1], plus the
 * trajectory convergence rate `conv` (deep-matching #6; default 0 ⇒ no drift /
 * cold-start, so every existing caller is unchanged bit-for-bit).
 */
function expandPair(a, b, conv = 0) {
  return {
    dist: Math.abs(a - b),
    mean: (a + b) / 2,
    min: Math.min(a, b),
    max: Math.max(a, b),
    prod: a * b,
    conv: Number.isFinite(conv) ? conv : 0,
  };
}

/** Logit of a {intercept, coef:{fn:β}} shape on a feature map. Missing β ⇒ 0. */
function shapeLogit(intercept, coef, features) {
  let z = intercept || 0;
  for (const fn of BASIS_FNS) {
    const c = coef && coef[fn];
    if (isFin(c)) z += c * (features[fn] ?? 0);
  }
  return z;
}

/**
 * Batch-GD logistic over a fixed feature set, L2-regularized TOWARD a prior
 * coefficient vector (the cold-start anchor). Backtracking line search →
 * monotone, no divergence. Returns {ok, intercept, coef, logLoss, n}.
 */
function fitLogistic(rows, y, opts = {}) {
  const fns = opts.features || BASIS_FNS;
  const l2 = opts.l2 ?? 0.05;
  const maxIt = opts.maxIterations ?? 4000;
  const tol = opts.tolerance ?? 1e-9;
  const lr0 = opts.learningRate ?? 0.3;
  const priorCoef = opts.priorCoef || {};
  const priorB = opts.priorIntercept ?? 0;

  const n = rows.length;
  if (n < 2) return { ok: false, reason: 'too few rows' };
  if (!y.some((v) => v === 1) || !y.some((v) => v === 0)) return { ok: false, reason: 'one class' };

  const k = fns.length;
  const w = fns.map((fn) => priorCoef[fn] ?? 0);
  let b = priorB;

  const X = rows.map((r) => fns.map((fn) => r[fn] ?? 0));
  const dataLoss = (wA, bV) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      let z = bV;
      for (let j = 0; j < k; j++) z += wA[j] * X[i][j];
      const p = clamp(sigmoid(z), EPS, 1 - EPS);
      s += -(y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p));
    }
    return s / n;
  };
  const obj = (wA, bV) => {
    let reg = 0;
    for (let j = 0; j < k; j++) { const d = wA[j] - (priorCoef[fns[j]] ?? 0); reg += d * d; }
    return dataLoss(wA, bV) + (l2 / 2) * reg;
  };

  let lr = lr0, prev = obj(w, b);
  for (let it = 0; it < maxIt; it++) {
    const gw = new Array(k).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < k; j++) z += w[j] * X[i][j];
      const err = sigmoid(z) - y[i];
      gb += err;
      for (let j = 0; j < k; j++) gw[j] += err * X[i][j];
    }
    gb /= n;
    for (let j = 0; j < k; j++) gw[j] = gw[j] / n + l2 * (w[j] - (priorCoef[fns[j]] ?? 0));

    let accepted = false;
    for (let bt = 0; bt < 40; bt++) {
      const wNew = w.map((wj, j) => wj - lr * gw[j]);
      const bNew = b - lr * gb;
      const o = obj(wNew, bNew);
      if (Number.isFinite(o) && o <= prev) {
        const improvement = prev - o;
        for (let j = 0; j < k; j++) w[j] = wNew[j];
        b = bNew; prev = o; accepted = true;
        lr = Math.min(lr * 1.1, lr0);
        if (improvement < tol) return done();
        break;
      }
      lr *= 0.5;
    }
    if (!accepted) return done();
  }
  return done();

  function done() {
    const coef = {};
    fns.forEach((fn, j) => { coef[fn] = w[j]; });
    return { ok: true, intercept: b, coef, logLoss: dataLoss(w, b), n };
  }
}

/** Mean negative log-loss of a shape over rows. */
function meanLogLoss(intercept, coef, rows, y) {
  let s = 0;
  for (let i = 0; i < rows.length; i++) {
    const p = clamp(sigmoid(shapeLogit(intercept, coef, rows[i])), EPS, 1 - EPS);
    s += -(y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p));
  }
  return rows.length ? s / rows.length : NaN;
}

/** ROC AUC of a shape over rows (reported for visibility; ties = 0.5). */
function auc(intercept, coef, rows, y) {
  const scored = rows.map((r, i) => ({ p: sigmoid(shapeLogit(intercept, coef, r)), y: y[i] }));
  const pos = scored.filter((s) => s.y === 1);
  const neg = scored.filter((s) => s.y === 0);
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Cold-start dist-only prior: closeness ⇒ success ⇒ negative weight on dist. */
function distOnlyPrior(importance = 1) {
  return { intercept: 0, coef: { dist: -Math.abs(importance), mean: 0, min: 0, max: 0, prod: 0, conv: 0 } };
}

/** Name the shape from coefficient signs. */
function classifyType(coef, opts = {}) {
  const tDist = opts.distThreshold ?? 0.25;
  const tMax = opts.maxThreshold ?? 0.5;
  if (isFin(coef.dist) && coef.dist > tDist) return 'complementarity';
  if (isFin(coef.max) && coef.max < -tMax) return 'directional';
  return 'similarity';
}

/** Deterministic train/held-out split (every Nth row → held-out). */
function splitTrainHoldout(rows, y, holdoutFraction) {
  if (rows.length < 8) return null;
  const stride = Math.max(2, Math.round(1 / Math.min(0.5, Math.max(0.1, holdoutFraction))));
  const tr = [], trY = [], ho = [], hoY = [];
  rows.forEach((r, i) => {
    if (i % stride === 0) { ho.push(r); hoY.push(y[i]); }
    else { tr.push(r); trY.push(y[i]); }
  });
  const both = (yy) => yy.some((v) => v === 1) && yy.some((v) => v === 0);
  if (ho.length < 3 || tr.length < 4 || !both(trY) || !both(hoY)) return null;
  return { tr, trY, ho, hoY };
}

/**
 * Fit one dimension's shape from outcome records, gated on held-out outcomes.
 *
 * records: [{ a, b, success }]  (a,b normalized ∈ [0,1])
 * opts.importance      — cold-start dist prior strength (default 1)
 * opts.allowedTypes    — which non-similarity shapes may ship for this dim
 *                        (e.g. ['complementarity'] or ['directional']). A learned
 *                        shape outside this set is REJECTED even if it fits — the
 *                        prior says which way thin data is allowed to nudge.
 * opts.minImprovement  — min held-out log-loss gain (baseline − basis) to ship.
 *
 * Returns a shape object consumed by displayDelta(). `certified:false` ⇒ scorer
 * stays on the dist-only curve (today). Refits on ALL data once gated.
 */
function fitDimensionGated(records, opts = {}) {
  const importance = opts.importance ?? 1;
  const allowedTypes = opts.allowedTypes || [];
  const minImprovement = opts.minImprovement ?? 0.01;
  const holdoutFraction = opts.holdoutFraction ?? 0.3;
  const prior = distOnlyPrior(importance);

  const rows = [], y = [];
  for (const r of records) {
    if (!isFin(r.a) || !isFin(r.b)) continue;
    rows.push(expandPair(r.a, r.b, r.conv));
    y.push(r.success ? 1 : 0);
  }

  const baseline = {
    certified: false,
    type: 'similarity',
    n: rows.length,
    auc: NaN,
    aucBaseline: NaN,
    baseline: prior,
    basis: prior,
    reason: 'dist-only prior (cold-start)',
  };

  const split = splitTrainHoldout(rows, y, holdoutFraction);
  if (!split) return baseline;

  // The baseline is the FIXED cold-start curve (today's behavior) — NOT a refit.
  // This is the crux: a refit dist-only model can itself flip β_dist>0 and absorb
  // complementarity, hiding it from the gate and leaving the inverted similarity
  // curve in production. Gating against the fixed prior is what lets a genuinely
  // complementary dimension (which today's curve scores worse-than-chance) win.
  const fitOpts = { priorCoef: prior.coef, priorIntercept: prior.intercept, l2: opts.l2 };
  const fullFit = fitLogistic(split.tr, split.trY, { ...fitOpts, features: BASIS_FNS });
  if (!fullFit.ok) return baseline;

  const baseHo = meanLogLoss(prior.intercept, prior.coef, split.ho, split.hoY);
  const fullHo = meanLogLoss(fullFit.intercept, fullFit.coef, split.ho, split.hoY);
  const improvement = baseHo - fullHo;
  const type = classifyType(fullFit.coef);

  // Ship ONLY if the basis beats today's fixed curve on held-out AND its learned
  // shape is an allowed direction for this dimension (a similarity result never
  // needs the basis; a complementarity/directional result must be pre-authorized
  // by PRIOR_DIRECTIONS — thin data can't flip a dimension we didn't sanction).
  if (!(Number.isFinite(improvement) && improvement >= minImprovement) || !allowedTypes.includes(type)) {
    return {
      ...baseline,
      auc: auc(fullFit.intercept, fullFit.coef, rows, y),
      aucBaseline: auc(prior.intercept, prior.coef, rows, y),
      reason: !allowedTypes.includes(type)
        ? `learned shape '${type}' not allowed for this dimension — keeping dist-only`
        : `basis did not clear the gate (held-out gain ${improvement.toFixed(4)} < ${minImprovement})`,
    };
  }

  // Earned it. Refit the basis on ALL data; baseline stays the fixed prior.
  const fullAll = fitLogistic(rows, y, { ...fitOpts, features: BASIS_FNS });
  const finalFull = fullAll.ok ? fullAll : fullFit;
  return {
    certified: true,
    type,
    n: rows.length,
    auc: auc(finalFull.intercept, finalFull.coef, rows, y),
    aucBaseline: auc(prior.intercept, prior.coef, rows, y),
    baseline: prior,
    basis: { intercept: finalFull.intercept, coef: finalFull.coef },
    reason: `basis '${type}' improved held-out log-loss by ${improvement.toFixed(4)}`,
  };
}

// Maximum amount a certified shape may move a dimension's 0..1 contribution away
// from today's curve, per pair. Bounds blast radius even on a confident model.
const DISPLAY_DELTA_MAX = 0.5;

/**
 * The display adjustment a certified shape applies to a dimension's 0..1
 * contribution, for one pair. It is the success-probability the certified shape
 * assigns this pair MINUS what the similarity baseline assigns — so a
 * complementary dim lifts far-apart pairs and trims two-of-a-kind, bounded to
 * ±DISPLAY_DELTA_MAX. Returns 0 for an uncertified shape (⇒ scorer = today).
 */
function displayDelta(shape, a, b, conv = 0) {
  if (!shape || !shape.certified || !isFin(a) || !isFin(b)) return 0;
  const f = expandPair(a, b, conv);
  const pSpec = sigmoid(shapeLogit(shape.basis.intercept, shape.basis.coef, f));
  const pBase = sigmoid(shapeLogit(shape.baseline.intercept, shape.baseline.coef, f));
  return clamp(pSpec - pBase, -DISPLAY_DELTA_MAX, DISPLAY_DELTA_MAX);
}

// Project a NORMALIZED value v ∈ [0,1] forward by a normalized velocity (per 30d)
// to horizon H, clamped to [0,1]. Zero/non-finite velocity ⇒ unchanged.
function projectVal(v, vel, horizonDays) {
  const ve = Number(vel);
  if (!Number.isFinite(ve) || ve === 0) return v;
  const H = Number.isFinite(horizonDays) && horizonDays > 0 ? horizonDays : 90;
  return Math.min(1, Math.max(0, v + ve * (H / 30)));
}

/**
 * Gate trajectory PROJECTION for a dimension: does scoring it on velocity-
 * projected values beat the snapshot on held-out outcomes? records carry
 * { a, b, success, conv, vA, vB } (normalized). Returns { project, improvement, n }.
 * project=false on thin data ⇒ the dimension keeps snapshot-only scoring (today).
 */
function fitProjectionGated(records, opts = {}) {
  const minImprovement = opts.minImprovement ?? 0.01;
  const horizonDays = opts.horizonDays ?? 90;
  const importance = opts.importance ?? 1;
  const holdoutFraction = opts.holdoutFraction ?? 0.3;
  const prior = distOnlyPrior(importance);
  const fitOpts = { priorCoef: prior.coef, priorIntercept: prior.intercept };

  const cur = [], prj = [], y = [];
  for (const r of records) {
    if (!isFin(r.a) || !isFin(r.b)) continue;
    cur.push(expandPair(r.a, r.b, r.conv));
    prj.push(expandPair(projectVal(r.a, r.vA, horizonDays), projectVal(r.b, r.vB, horizonDays), r.conv));
    y.push(r.success ? 1 : 0);
  }
  const n = cur.length;
  if (n < 8) return { project: false, improvement: 0, n, reason: 'insufficient data' };

  const stride = Math.max(2, Math.round(1 / Math.min(0.5, Math.max(0.1, holdoutFraction))));
  const idxTr = [], idxHo = [];
  for (let i = 0; i < n; i++) (i % stride === 0 ? idxHo : idxTr).push(i);
  const both = (idx) => idx.some(i => y[i] === 1) && idx.some(i => y[i] === 0);
  if (idxHo.length < 3 || idxTr.length < 4 || !both(idxTr) || !both(idxHo)) {
    return { project: false, improvement: 0, n, reason: 'split too small / single-class' };
  }
  const pick = (arr, idx) => idx.map(i => arr[i]);
  const trY = idxTr.map(i => y[i]), hoY = idxHo.map(i => y[i]);
  const curFit = fitLogistic(pick(cur, idxTr), trY, { ...fitOpts, features: BASIS_FNS });
  const prjFit = fitLogistic(pick(prj, idxTr), trY, { ...fitOpts, features: BASIS_FNS });
  if (!curFit.ok || !prjFit.ok) return { project: false, improvement: 0, n, reason: 'fit failed' };
  const curHo = meanLogLoss(curFit.intercept, curFit.coef, pick(cur, idxHo), hoY);
  const prjHo = meanLogLoss(prjFit.intercept, prjFit.coef, pick(prj, idxHo), hoY);
  const improvement = curHo - prjHo;
  return {
    project: Number.isFinite(improvement) && improvement >= minImprovement,
    improvement: Number.isFinite(improvement) ? improvement : 0,
    n,
    reason: `projection held-out gain ${Number.isFinite(improvement) ? improvement.toFixed(4) : 'n/a'}`,
  };
}

// Log-odds of a base success rate (intercept-only model: no feature at all).
function baseRateLogit(y) {
  const p = y.reduce((s, v) => s + v, 0) / Math.max(1, y.length);
  const c = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(c / (1 - c));
}

/**
 * Gate a candidate FEATURE (deep-matching #5 LLM constructs): does scoring the
 * pair on this feature's basis beat the NO-FEATURE model (the base success rate)
 * on held-out outcomes? This is the honest "beats without-it" test — a
 * hallucinated/non-predictive feature looks fine in-sample and fails held-out,
 * so it stays uncertified (weight 0). records carry { a, b, success } (a,b ∈ [0,1]).
 *
 * Differs from fitDimensionGated, whose baseline is the dist-only PRIOR — here
 * the baseline is "no feature" so a genuinely predictive feature (even a plain
 * similarity one) can earn its place; the prior would have hidden it.
 */
function fitConstructGated(records, opts = {}) {
  const minImprovement = opts.minImprovement ?? 0.01;
  const holdoutFraction = opts.holdoutFraction ?? 0.3;
  const rows = [], y = [];
  for (const r of records) {
    if (!isFin(r.a) || !isFin(r.b)) continue;
    rows.push(expandPair(r.a, r.b, r.conv));
    y.push(r.success ? 1 : 0);
  }
  const off = {
    certified: false, type: 'none', n: rows.length, auc: NaN, aucBaseline: NaN,
    baseline: { intercept: 0, coef: {} }, basis: { intercept: 0, coef: {} },
    reason: 'no signal (cold-start)',
  };
  const split = splitTrainHoldout(rows, y, holdoutFraction);
  if (!split) return off;

  const b0 = baseRateLogit(split.trY);              // no-feature baseline
  const full = fitLogistic(split.tr, split.trY, { features: BASIS_FNS, l2: opts.l2 });
  if (!full.ok) return off;

  const baseHo = meanLogLoss(b0, {}, split.ho, split.hoY);
  const fullHo = meanLogLoss(full.intercept, full.coef, split.ho, split.hoY);
  const improvement = baseHo - fullHo;
  if (!(Number.isFinite(improvement) && improvement >= minImprovement)) {
    return { ...off, auc: auc(full.intercept, full.coef, rows, y),
      reason: `feature did not beat no-feature (held-out gain ${Number.isFinite(improvement) ? improvement.toFixed(4) : 'n/a'})` };
  }
  const fullAll = fitLogistic(rows, y, { features: BASIS_FNS, l2: opts.l2 });
  const finalFull = fullAll.ok ? fullAll : full;
  return {
    certified: true,
    type: classifyType(finalFull.coef),
    n: rows.length,
    auc: auc(finalFull.intercept, finalFull.coef, rows, y),
    aucBaseline: NaN,
    baseline: { intercept: baseRateLogit(y), coef: {} },
    basis: { intercept: finalFull.intercept, coef: finalFull.coef },
    reason: `feature beat no-feature by ${improvement.toFixed(4)}`,
  };
}

module.exports = {
  BASIS_FNS,
  expandPair,
  projectVal,
  fitProjectionGated,
  fitConstructGated,
  fitLogistic,
  distOnlyPrior,
  classifyType,
  fitDimensionGated,
  displayDelta,
  shapeLogit,
  auc,
  meanLogLoss,
  DISPLAY_DELTA_MAX,
};
