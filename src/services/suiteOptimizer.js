// ─── Suite optimizer (deep-matching #4: graph / group optimization) ─────────
//
// A suite (apartment-sized group) is scored by its WEAKEST internal pair, never
// the average — a high average that hides one miserable pairing is a lie, and
// the app literally names that weakest pair. So:
//   suiteScore  = MIN over all pairwise scores in the group
//   weakestPair = that argmin pair
// and we optimize for the MAXIMIN: pick groupings that maximize the minimum
// internal pair score, so nobody is sacrificed for a good group average.
//
// Graph: nodes = eligible students, edge = the existing pairwise compatibility
// score (already composes #2 dimension-combination + #6 trajectory when they're
// certified — we never re-derive). Any INVALID pair (dealbreaker / hard cap /
// gender-pref violation / block) makes the whole group invalid and it is dropped.
//
// Small pools (the realistic case) get the EXACT global maximin by enumerating
// every valid group — that is the spec's "global optimization beats greedy",
// for free at this scale. Large pools fall back to greedy seeding + local-search
// swaps. Deterministic throughout (stable input order + deterministic tie-breaks).
//
// Pure: the pairwise scorer/validator is injected, so this file is DB-free and
// directly unit-testable.

const DEFAULT_SIZES = [3, 4];
const EXHAUSTIVE_MAX_N = 40;   // enumerate exactly up to here; greedy beyond
const GREEDY_SEED_FACTOR = 4;  // seeds tried per requested suite in the greedy path

// Deterministic k-combinations of indices [0..n). Ascending, lexicographic.
function* combinations(n, k) {
  if (k > n || k <= 0) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx;
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

// Evaluate a group of member indices into a candidate, or null if any pair is
// invalid (hard-blocked / dealbreaker / gender / block).
function evalGroup(idxs, P) {
  let minScore = Infinity;
  let weakest = null;
  const pairs = [];
  for (let x = 0; x < idxs.length; x++) {
    for (let y = x + 1; y < idxs.length; y++) {
      const v = P(idxs[x], idxs[y]);
      if (!v || !v.valid) return null;          // one bad pair invalidates the suite
      const pair = { i: idxs[x], j: idxs[y], score: v.score, topFrictionTopic: v.topFrictionTopic ?? null };
      pairs.push(pair);
      if (v.score < minScore || (v.score === minScore && weakest && pairKey(pair) < pairKey(weakest))) {
        minScore = v.score;
        weakest = pair;
      }
    }
  }
  if (!weakest) return null;
  const avg = pairs.reduce((s, p) => s + p.score, 0) / pairs.length;
  return { idxs: idxs.slice(), suiteScore: minScore, weakest, pairs, avg };
}

const pairKey = (p) => `${Math.min(p.i, p.j)},${Math.max(p.i, p.j)}`;

// Maximin-first ordering: highest minimum, then highest average (a tie-break that
// still favors stronger suites), then a stable index order for determinism.
function cmpSuite(a, b) {
  if (b.suiteScore !== a.suiteScore) return b.suiteScore - a.suiteScore;
  if (b.avg !== a.avg) return b.avg - a.avg;
  return a.idxs.join(',').localeCompare(b.idxs.join(','));
}

// Greedy: seed from the best valid edges, then repeatedly add the member that
// MAXIMIZES the resulting minimum internal score while keeping every pair valid.
// One local-search pass of improving swaps follows. Used only for large pools.
function greedyCandidates(n, sizes, P, count) {
  const edges = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const v = P(i, j);
    if (v && v.valid) edges.push({ i, j, score: v.score });
  }
  edges.sort((a, b) => b.score - a.score || (a.i - b.i) || (a.j - b.j));
  const out = [];
  const seedCount = Math.max(1, count * GREEDY_SEED_FACTOR);

  for (const size of sizes) {
    for (let s = 0; s < edges.length && s < seedCount; s++) {
      let group = [edges[s].i, edges[s].j];
      let ok = true;
      while (group.length < size) {
        let best = -1, bestMin = -Infinity;
        for (let c = 0; c < n; c++) {
          if (group.includes(c)) continue;
          let m = Infinity, valid = true;
          for (const g of group) { const v = P(g, c); if (!v || !v.valid) { valid = false; break; } m = Math.min(m, v.score); }
          if (!valid) continue;
          if (m > bestMin || (m === bestMin && c < best)) { bestMin = m; best = c; }
        }
        if (best < 0) { ok = false; break; }   // no valid completion
        group.push(best);
      }
      if (!ok || group.length < size) continue;
      let cand = evalGroup(group.slice().sort((a, b) => a - b), P);
      if (cand) cand = localSearch(cand, n, P);
      if (cand) out.push(cand);
    }
  }
  return out;
}

// Local search: try replacing one member with an outsider; keep the first swap
// that raises the suite's minimum (maximin). Repeat until no improving move.
function localSearch(cand, n, P) {
  let cur = cand;
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (const m of cur.idxs) {
      for (let o = 0; o < n; o++) {
        if (cur.idxs.includes(o)) continue;
        const swapped = cur.idxs.map(x => (x === m ? o : x)).sort((a, b) => a - b);
        const next = evalGroup(swapped, P);
        if (next && next.suiteScore > cur.suiteScore) { cur = next; improved = true; break; }
      }
      if (improved) break;
    }
  }
  return cur;
}

function suiteMember(m) {
  const out = { userId: m.userId, firstName: m.firstName, lastInitial: m.lastInitial };
  if (m.photoUrl) out.photoUrl = m.photoUrl;
  if (m.schoolYear) out.schoolYear = m.schoolYear;
  return out;
}

function suitePair(p, members) {
  const out = { a: members[p.i].userId, b: members[p.j].userId, score: Math.round(p.score) };
  if (p.topFrictionTopic) out.topFrictionTopic = p.topFrictionTopic;
  return out;
}

function formatSuite(c, members) {
  return {
    suiteScore: Math.round(c.suiteScore),
    members: c.idxs.map(i => suiteMember(members[i])),
    pairs: c.pairs.map(p => suitePair(p, members)),
    weakestPair: suitePair(c.weakest, members),
  };
}

/**
 * Build the best valid suites over an eligible member pool.
 *
 * @param members  array of { userId, firstName, lastInitial, photoUrl?, schoolYear? }
 *                 in a STABLE order (the route sorts by userId for determinism).
 * @param opts.pairEval (i, j) => { score:number, valid:boolean, topFrictionTopic?:string }
 *                 the injected pairwise scorer/validator (i < j).
 * @param opts.sizes  candidate group sizes (default [3, 4]).
 * @param opts.count  how many suites to return (highest maximin first).
 * @returns Suite[] — possibly empty. Empty whenever the pool can't form even one
 *          VALID group of any requested size. Never padded, never fabricated.
 */
function buildSuites(members, opts = {}) {
  const pairEval = opts.pairEval;
  const count = Math.max(1, opts.count || 1);
  const n = Array.isArray(members) ? members.length : 0;
  const sizes = (Array.isArray(opts.sizes) && opts.sizes.length ? opts.sizes : DEFAULT_SIZES)
    .filter(s => s >= 2 && s <= n)
    .sort((a, b) => a - b);
  if (typeof pairEval !== 'function' || n < 2 || sizes.length === 0) return [];

  // Memoized symmetric pair lookup.
  const cache = new Map();
  const P = (i, j) => {
    const key = i < j ? `${i},${j}` : `${j},${i}`;
    let v = cache.get(key);
    if (v === undefined) {
      const [x, y] = i < j ? [i, j] : [j, i];
      v = pairEval(x, y) || { score: 0, valid: false };
      cache.set(key, v);
    }
    return v;
  };

  let candidates = [];
  if (n <= EXHAUSTIVE_MAX_N) {
    for (const size of sizes) {
      for (const combo of combinations(n, size)) {
        const cand = evalGroup(combo, P);
        if (cand) candidates.push(cand);
      }
    }
  } else {
    candidates = greedyCandidates(n, sizes, P, count);
  }

  candidates.sort(cmpSuite);
  const out = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = c.idxs.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(formatSuite(c, members));
    if (out.length >= count) break;
  }
  return out;
}

module.exports = { buildSuites, combinations, EXHAUSTIVE_MAX_N, DEFAULT_SIZES };
