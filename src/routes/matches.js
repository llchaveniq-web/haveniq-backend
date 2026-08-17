const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, refuseBanned } = require('../middleware/auth');
const { NO_DASH_RULE, stripDashes, stripDashesDeep } = require('../lib/textStyle');
const suspicious = require('../middleware/suspiciousActivity');
const { sendParentMatchEmail, sendSafetyAlertEmail, sendMatchEmail, sendConnectRequestEmail } = require('../services/email');
const { isFounder, isFounderUser } = require('../utils/founders');
const { computePairing } = require('../services/personalityPairing');
const { notDemo, isDemoEmail } = require('../lib/demoFilter');
const { MATCH_MIN_SCORE } = require('../lib/matchConfig');
const { isViable, applyCampusRanking } = require('../services/matchViability');
const { recordPairingEvent, recordFeedImpressions, buildServeFeatures } = require('../services/pairingOutcomes');
// Pre-match photo gallery (owner decision 2026-07-22: faces visible while choosing).
const { galleryJoin, photosFor } = require('../lib/photoGallery');
const { loadDrift } = require('../services/pulseDrift');
const { calculateCompatibility, topFrictionTopic, matchingV11Enabled, flatten } = require('../services/scoring');
const QUIZ_QUESTIONS = require('../data/quizQuestions');
const questionsById = Object.fromEntries(QUIZ_QUESTIONS.map((q) => [q.id, q]));
const { computeFrictions } = require('../services/friction');
const { loadCertifiedModels } = require('../services/dimensionModel');
const { buildSuites } = require('../services/suiteOptimizer');
const { loadFeatures: loadTextInsightFeatures } = require('../services/textInsight');
// Earned roommate reputation badge (docs/BACKEND_ROOMMATE_REPUTATION.md) —
// only attached on the single match-detail route below, never the feed: it's
// a per-user aggregate query, too expensive to run once per feed row. Sourced
// from the mutual, verified roommate_vouches system (gated on real match
// history), not src/routes/vouches.js's public unverified testimonials.
const { computeTrackRecord, bothMovedInTogether } = require('./roommateVouches');
const { logDecision, getUserCategoryWeights, personalRankScore } = require('../services/decisionLearning');
const { safetyReport, safetyBlock, aiLimiter } = require('../middleware/rateLimits');
const { audit } = require('../services/auditLog');
const analytics = require('../services/analytics');

// Access gate for the AI-narrative / detail match endpoints (openers, explain,
// score-history). A bare compatibility_scores row was too broad — one exists
// for ANY quiz-completed pair, so an authed user could pull Claude-narrated fit
// reports (and score timelines) on strangers at other schools: cheap
// enumeration. The legitimate audience is people you'd actually room with:
// someone on YOUR campus (the pre-connect feed already shows their fit report),
// or anyone you've opened a connect request with (the path a thin-pool
// cross-school match takes next). Returns true iff the viewer may see match
// detail about targetId. Cheap (indexed lookups), and both branches only ever
// match pairs the engine actually scored, so nothing legitimate is lost.
async function mayViewMatchDetail(viewerId, viewerSchool, targetId) {
  if (viewerSchool && viewerSchool.trim()) {
    const { rows } = await pool.query(
      `SELECT 1 FROM users
        WHERE id = $1 AND school IS NOT NULL
          AND lower(trim(school)) = lower(trim($2)) LIMIT 1`,
      [targetId, viewerSchool],
    );
    if (rows.length) return true;
  }
  const { rows: cr } = await pool.query(
    `SELECT 1 FROM connect_requests
      WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)
      LIMIT 1`,
    [viewerId, targetId],
  );
  return cr.length > 0;
}

// Real quiz-answer overlap between two users, for the AI narrative routes
// below (openers, explain). quiz_answers has ONE row per user with a JSONB
// `answers` column ({ "14": 1, "48": 2, ... } question_id -> chosen option
// index, sometimes wrapped as { type: 'option', index: N } — see scoring.js's
// flatten()). This route used to query a (user_id, question_id, answer_value)
// row-per-answer shape that has never existed in this schema, so it always
// silently returned nothing (wrapped in a bare .catch) — while the prompts
// below confidently asserted specific "you both said X" claims about real
// students anyway. hasQuizData tells the prompt when it genuinely has
// nothing to work with, so it stops inventing instead of staying quiet.
async function loadQuizOverlap(viewerId, targetId) {
  const { rows } = await pool.query(
    `SELECT user_id, answers FROM quiz_answers WHERE user_id IN ($1, $2)`,
    [viewerId, targetId],
  ).catch(() => ({ rows: [] }));

  const myFlat    = flatten(rows.find((r) => r.user_id === viewerId)?.answers);
  const theirFlat = flatten(rows.find((r) => r.user_id === targetId)?.answers);

  const agreements = [];
  const divergences = [];
  for (const [qid, myIdx] of Object.entries(myFlat)) {
    if (!(qid in theirFlat)) continue;
    const q = questionsById[Number(qid)];
    if (!q) continue; // retired/unmapped question id — skip rather than guess at its topic
    const theirIdx = theirFlat[qid];
    const myOpt = q.options?.[myIdx];
    const theirOpt = q.options?.[theirIdx];
    if (myOpt === undefined || theirOpt === undefined) continue;
    if (myIdx === theirIdx) {
      agreements.push({ question_id: Number(qid), category: q.category, text: q.text, both: myOpt });
    } else {
      divergences.push({ question_id: Number(qid), category: q.category, text: q.text, you: myOpt, them: theirOpt });
    }
  }

  return {
    hasQuizData: Object.keys(myFlat).length > 0 && Object.keys(theirFlat).length > 0,
    agreements,
    divergences,
  };
}

// Best-effort parent notification on a student's FIRST accepted match.
// Called twice — once for each side of the pair. Each user's row has
// `parent_notified` which gates against repeat sends. Wrapped in its own
// try/catch so a parent-email failure never blocks the accept response.
async function maybeNotifyParent(studentId, matchUserId) {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.first_name, u.parent_email, u.parent_notified,
              m.first_name AS match_first, m.last_name AS match_last, m.school AS match_school,
              cs.score AS compatibility
       FROM users u
       JOIN users m ON m.id = $2
       LEFT JOIN compatibility_scores cs
              ON (cs.user_a = LEAST(u.id, m.id) AND cs.user_b = GREATEST(u.id, m.id))
       WHERE u.id = $1`,
      [studentId, matchUserId],
    );
    const row = rows[0];
    if (!row || !row.parent_email || row.parent_notified) return;

    await sendParentMatchEmail({
      parentEmail:      row.parent_email,
      studentName:      row.first_name || 'Your student',
      matchName:        `${row.match_first} ${(row.match_last || '').charAt(0)}.`,
      matchSchool:      row.match_school,
      // null when the pair has no score row (the join is a LEFT JOIN). Passing
      // 0 here would have the email tell a parent "0% compatibility".
      compatibilityPct: row.compatibility == null ? null : Math.round(Number(row.compatibility)),
      userId:           studentId,
    });

    await pool.query(
      'UPDATE users SET parent_notified = TRUE WHERE id = $1',
      [studentId],
    );
  } catch (err) {
    console.error('[parent notify] send failed:', err);
  }
}

// Email the STUDENT themselves when a match forms. This is the ONLY
// re-engagement path that reaches web users: the app runs as a web SPA and
// push-token registration no-ops on web (HavenIQ-App utils/registerPushToken),
// so the "request accepted" push above never arrives for them. Without this
// email a matched student who isn't actively on the site is never told and
// doesn't come back. Best-effort + its own try/catch so it never blocks the
// accept response. Skips seeded demo accounts (no real inbox).
async function maybeEmailMatch(studentId, matchUserId) {
  try {
    const { rows } = await pool.query(
      `SELECT u.email AS to_email, u.first_name AS to_name,
              m.first_name AS match_first, m.last_name AS match_last,
              cs.score AS compatibility
       FROM users u
       JOIN users m ON m.id = $2
       LEFT JOIN compatibility_scores cs
              ON (cs.user_a = LEAST(u.id, m.id) AND cs.user_b = GREATEST(u.id, m.id))
       WHERE u.id = $1`,
      [studentId, matchUserId],
    );
    const row = rows[0];
    if (!row || !row.to_email) return;
    if (isDemoEmail(row.to_email)) return; // demo/test accounts — never app-email
    await sendMatchEmail(
      row.to_email,
      row.to_name || 'there',
      `${row.match_first || ''} ${(row.match_last || '').charAt(0)}.`.trim(),
      Math.round(Number(row.compatibility) || 0),
      studentId,
    );
  } catch (err) {
    console.error('[match email] send failed:', err);
  }
}

// Email the recipient when a connect request is RECEIVED — the top-of-funnel
// re-engagement moment. Same web-push-is-dead rationale as maybeEmailMatch.
// Best-effort; skips seeded demo accounts.
async function maybeEmailConnectRequest(toUserId, fromUserId, score) {
  try {
    const { rows } = await pool.query(
      `SELECT u.email AS to_email, u.first_name AS to_name,
              f.first_name AS from_first, f.last_name AS from_last
         FROM users u JOIN users f ON f.id = $2
        WHERE u.id = $1`,
      [toUserId, fromUserId],
    );
    const row = rows[0];
    if (!row || !row.to_email) return;
    if (isDemoEmail(row.to_email)) return;
    await sendConnectRequestEmail(
      row.to_email,
      row.to_name || 'there',
      `${row.from_first || ''} ${(row.from_last || '').charAt(0)}.`.trim(),
      Math.round(Number(score) || 0),
      toUserId,
    );
  } catch (err) {
    console.error('[connect-request email] send failed:', err);
  }
}

// ── GET /matches/feed ─────────────────────────────────────────────────────
// Returns scored, filtered matches for the current user
// Feed gets pulled on every app open + manual refresh — 100/5min is the
// threshold. A user who refreshes 20x is still fine; one pulling the feed
// programmatically every 3 seconds (200/5min) trips the audit log.
// Map ONE scored row (the feed's SELECT shape) to the flat match DTO the app
// consumes (stores/matchStore.transformBackendMatch expects exactly these keys).
// Shared by the feed and the single-pair GET /:userId resolver so the two can
// never drift. `ctx` carries the viewer-scoped inputs the mapping needs:
//   me        – viewer's { mbti, disc } for the display-only personality pairing
//   myAnswers – viewer's raw quiz answers, for the both-sides friction forecast
//   mySchool  – viewer's campus, for the cross-school flag
function buildMatchDTO(r, { me = {}, myAnswers = null, mySchool = null } = {}) {
  // Part 2 honesty gate: only surface the behavioral-validation layer when
  // the multiplier is genuinely ≠ 1.0 (BOTH users had a real validation_score
  // at score time). At a neutral 1.0 we OMIT both fields so the app renders
  // nothing — no "validated" badge without real signal (trust fraud).
  const vMult = r.validation_multiplier != null ? Number(r.validation_multiplier) : 1;
  const validationFields = (vMult !== 1 && r.pre_validation_pct != null)
    ? { validationMultiplier: vMult, preValidationPct: r.pre_validation_pct }
    : {};
  // Deep-matching #2: surface complementarity only when present (a certified
  // shape made this pair fit BECAUSE they differ). Omitted otherwise so the
  // app shows nothing — "balance" is a finding, never a default.
  const compDims = Array.isArray(r.complementary_dims) ? r.complementary_dims : [];
  const complementaryFields = compDims.length ? { complementaryDims: compDims } : {};
  // Deep-matching #6: surface trajectory ("converging") dims only when present.
  const convDims = Array.isArray(r.converging_dims) ? r.converging_dims : [];
  const convergingFields = convDims.length ? { convergingDims: convDims } : {};
  // Specific friction forecast — "where you'll clash + the exact script",
  // computed here because this is the only place BOTH answer sets exist (the
  // client never receives another student's raw answers). A certified
  // complementary dim is a balance, not a fight, so it's suppressed. Empty
  // array is omitted so the app shows nothing rather than a hollow section.
  const suppressDims = compDims.map(d => Number(d && d.qid)).filter(Number.isFinite);
  const topFrictions = computeFrictions(myAnswers, r.candidate_answers, { suppressDims, n: 3 });
  const frictionFields = topFrictions.length ? { topFrictions } : {};
  return ({
    userId:        r.id,
    firstName:     r.first_name,
    // Only the initial ever leaves the server — never the full surname. The
    // UI shows "First L." everywhere, so the raw last name would be an unused
    // field sitting on another student's device (privacy policy §3).
    lastInitial:   (r.last_name || '').slice(0, 1).toUpperCase(),
    school:        r.school,
    schoolYear:    r.school_year,
    major:         r.major,
    bio:           r.bio,
    gender:        r.gender,
    lookingFor:    r.looking_for || [],
    photoUrl:      r.photo_url,
    // Ordered gallery (up to 4) — faces are now shown while CHOOSING a match,
    // not only after one. Falls back to [photo_url] for anyone who never used
    // the multi-photo manager, and [] when they have no photo at all.
    photos:        photosFor(r),
    budgetMin:     r.budget_min,
    budgetMax:     r.budget_max,
    moveInTimeline:r.move_in_timeline,
    isVerified:    r.is_verified,
    trustScore:    r.trust_score,
    // ID-verified timestamp from Stripe Identity. Null when the user
    // hasn't done selfie+ID; non-null = the "ID ✓" badge renders on
    // their match card. Distinct from `isVerified` (= .edu email).
    identityVerifiedAt: r.identity_verified_at,
    // Last time this candidate was active in the app — drives the
    // "Active today / Active Nd ago" presence label on their match card.
    lastActiveAt:  r.last_active_at,
    // Did they finish the setup screen (name + last initial + age + photo)?
    // FALSE is why a card renders as "Your match" + a grey silhouette: the
    // person is real and matchable, they just never filled their profile in.
    // Purely descriptive — the feed still returns them, in the same order.
    profileComplete: r.profile_complete === true,
    // Is this candidate from a DIFFERENT school than the viewer? Cross-school
    // rows only appear at all when the viewer's own campus pool is below
    // THIN_POOL (applyCampusRanking above), and they are appended AFTER the
    // same-school block.
    //
    // That grouping is currently lost: the app re-sorts the feed purely by
    // compatibility % ("rather than trusting the feed's order"), so a
    // cross-school 99 outranks a same-school 80 on screen. Exposing the fact
    // lets the client sort by (crossSchool, score) and get the intended
    // order back.
    //
    // Deliberately NOT done by penalizing the score: compatScore is shown to
    // students as a real compatibility number, and shading it by 15 points to
    // win an argument about sort order would make the displayed figure a lie.
    // Rank on the flag; keep the number true.
    crossSchool: !!(mySchool && r.school !== mySchool),
    compatScore:   parseFloat(r.score),
    // Confidence coefficient (0–1). <1 when either side's quiz answers are
    // thin/uniform — the scorer already multiplied compatScore down by it.
    // `isProvisional` lets the card render the number as "still learning you
    // two" instead of a hard figure that looks as certain as a full-data one.
    confidence:    r.confidence != null ? parseFloat(r.confidence) : 1,
    isProvisional: r.confidence != null && parseFloat(r.confidence) < 1,
    // Stress dimension (spec §4): { score, pattern, headline, pactSuggestion }.
    // Spread so the key is ABSENT (not null) when the pair has no stress read —
    // the frontend gates the "Under pressure" row on presence, so it stays
    // unrendered until the app flips STRESS_IDS into SCORED_IDS.
    ...(r.under_pressure ? { underPressure: r.under_pressure } : {}),
    isSoftBlocked: r.is_soft_blocked,
    shadowPenalty: parseFloat(r.shadow_penalty),
    breakdown:     r.breakdown || {},
    // Which lens the communication category % represents, so the compat-report
    // copy matches the math. Global (depends only on the v11 flag). Flag OFF ⇒
    // 'similarity' ⇒ the app's default copy ⇒ no visible change until v11 is on.
    communicationMode: matchingV11Enabled() ? 'adequacy' : 'similarity',
    whyMatched:    r.why_matched,
    // Secondary, display-only MBTI/DISC personality lens. Never affects
    // compatScore — see services/personalityPairing.js.
    pairing:       computePairing(me.mbti, me.disc, r.pairing_mbti, r.pairing_disc),
    // Direct MBTI / DISC strings for surfacing on the match card.
    // (`pairing` above already encodes the *relationship* between two
    // profiles; these are the raw type strings — "INFJ", "D" — that the
    // UI displays as a small pill so students see the psychology piece
    // they were promised, not just an opaque score.)
    mbti:          r.pairing_mbti || null,
    disc:          r.pairing_disc || null,
    connectStatus: r.connect_status || null,
    requestId:     r.connect_request_id || null,
    ...validationFields,
    ...complementaryFields,
    ...convergingFields,
    ...frictionFields,
  });
}

router.get('/feed', requireAuth, suspicious.track('matches.feed', 100), async (req, res) => {
  try {
    const userId = req.user.id;
    const { school } = req.query;  // optional school filter

    // Demos only appear when DEMO_FEED=true is explicitly set (investor
    // pitches: the conference, advisor meetings, etc.). Otherwise everyone
    // — including the founder — sees a real, bot-free match feed. Real
    // student trust is preserved because the filter still hides demos for
    // everyone else by default.
    const includeDemos = isFounderUser(req.user) && process.env.DEMO_FEED === 'true';
    const demoFilter   = includeDemos ? '' : `AND ${notDemo('u.email')}`;

    // Current user's MBTI/DISC — feeds the secondary personality-pairing
    // readout on each match card. Display-only; never touches scoring.
    const { rows: meRows } = await pool.query(
      'SELECT mbti, disc FROM personality_profiles WHERE user_id = $1',
      [userId],
    );
    const me = meRows[0] || {};

    // Viewer's own gender + roommate gender preference — used to filter the feed
    // so BOTH sides' stated preferences are respected (matching previously
    // ignored gender entirely → a student who only wants same-gender roommates
    // still saw, and scored high with, excluded genders). Empty preference or an
    // undeclared / "Prefer not to say" gender stays inclusive.
    const { rows: meUserRows } = await pool.query(
      `SELECT gender, looking_for, match_dealbreakers,
              school, budget_min, budget_max, move_in_timeline
         FROM users WHERE id = $1`,
      [userId],
    );
    const myGender     = meUserRows[0]?.gender ?? null;
    const myLookingFor = Array.isArray(meUserRows[0]?.looking_for) ? meUserRows[0].looking_for : [];

    // Viewer's own quiz answers — snapshotted into each served impression's
    // feature vector (pairing_outcomes logging). Does NOT touch scoring or the
    // response; best-effort, so a missing row just yields empty features.
    const { rows: meAnsRows } = await pool.query(
      'SELECT answers FROM quiz_answers WHERE user_id = $1',
      [userId],
    );
    const myAnswers = meAnsRows[0]?.answers || null;
    // v8 deal-breaker hard-filter (1d). Only the TRUE-hard, data-backed breaker
    // is hard-excluded (smoke-free, from Q51) so a cold-start deck never empties
    // on the soft ones. No-op until the viewer sets it (the app's deal-breaker
    // UI is still gated, so this is dormant in production until that ships).
    const myBreakers = (meUserRows[0]?.match_dealbreakers && typeof meUserRows[0].match_dealbreakers === 'object')
      ? meUserRows[0].match_dealbreakers : {};
    const smokeFree  = myBreakers.smokeFree === true;

    const { rows } = await pool.query(
      `SELECT
         cs.score,
         cs.is_soft_blocked,
         cs.shadow_penalty,
         cs.breakdown,
         cs.why_matched,
         cs.pre_validation_pct,
         cs.validation_multiplier,
         cs.complementary_dims,
         cs.converging_dims,
         cs.confidence,
         cs.under_pressure,
         dq.answers AS candidate_answers,
         u.id,
         u.first_name,
         u.last_name,
         u.school,
         u.school_year,
         u.major,
         u.bio,
         u.gender,
         u.looking_for,
         u.photo_url,
         u.budget_min,
         u.budget_max,
         u.move_in_timeline,
         u.is_verified,
         u.trust_score,
         u.identity_verified_at,
         u.last_active_at,
         -- Can this candidate be rendered as a PERSON? Exactly the two fields
         -- whose absence produces the "Your match" + grey-silhouette card.
         -- Deliberately NOT gated on last initial or age: the founder's own
         -- account has a real name and photo but a blank last_name, and it
         -- renders perfectly as "Jackson" — calling that incomplete would make
         -- the flag lie about a good profile.
         -- DESCRIPTIVE ONLY: changes no filtering and no ordering, so nobody
         -- disappears. The earlier attempt to GATE discovery on completeness
         -- silently hid real people (see the NOTE on the WHERE clause below).
         (u.first_name IS NOT NULL AND btrim(u.first_name) <> ''
          AND u.photo_url IS NOT NULL AND btrim(u.photo_url) <> '') AS profile_complete,
         pp.mbti  AS pairing_mbti,
         pp.disc  AS pairing_disc,
         ph.urls  AS photo_urls,
         cr.id     AS connect_request_id,
         cr.status AS connect_status
       FROM compatibility_scores cs
       JOIN users u ON (
         CASE WHEN cs.user_a = $1 THEN cs.user_b ELSE cs.user_a END = u.id
       )
       ${galleryJoin('u.id', 'ph')}
       LEFT JOIN personality_profiles pp ON pp.user_id = u.id
       LEFT JOIN connect_requests cr ON (
         (cr.from_user = $1 AND cr.to_user = u.id) OR
         (cr.to_user = $1   AND cr.from_user = u.id)
       )
       -- candidate's own quiz answers, for deal-breaker filters (Q51 smoke).
       -- quiz_answers is one row per user (UNIQUE user_id) so this never fans out.
       LEFT JOIN quiz_answers dq ON dq.user_id = u.id
       WHERE (cs.user_a = $1 OR cs.user_b = $1)
         AND cs.is_hard_blocked = FALSE
         AND cs.score >= ${MATCH_MIN_SCORE}
         AND u.is_paused = FALSE
         AND u.is_banned = FALSE
         AND u.quiz_completed = TRUE
         -- NOTE: no profile-completeness gate here. We tried gating discovery
         -- on name/age/photo/is_verified earlier and it silently broke real
         -- matches (an account that finished the quiz but not its profile, or
         -- lacked a photo, vanished from everyone's feed). Matching now shows
         -- any quiz-completed, non-blocked candidate — the same behavior that
         -- worked at launch. Incomplete profiles just render with fallbacks.
         -- Honor user_blocks in BOTH directions. If either side has
         -- blocked the other, the pair never appears in the feed.
         -- Algorithmic-block via cs.is_hard_blocked is separate.
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks ub
           WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id)
              OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
         )
         ${demoFilter}
         -- Mutual gender-preference filter. Respect BOTH sides: the candidate's
         -- gender must be in MY looking_for, AND my gender must be in THEIR
         -- looking_for. Either side with no preference (empty looking_for) or an
         -- undeclared / "Prefer not to say" gender passes (inclusive default).
         AND (
           $2::text[] IS NULL OR array_length($2::text[], 1) IS NULL
           OR u.gender IS NULL OR u.gender = 'Prefer not to say'
           OR u.gender = ANY($2::text[])
         )
         AND (
           u.looking_for IS NULL OR array_length(u.looking_for, 1) IS NULL
           OR $3::text IS NULL OR $3::text = 'Prefer not to say'
           OR $3::text = ANY(u.looking_for)
         )
         -- v8 deal-breaker hard-filter (1d): if the viewer set smoke-free, drop
         -- candidates who smoke/vape at home (Q51 index >= 2). Unanswered (→0) is
         -- not excluded. $4 = FALSE (unset) short-circuits to no filtering.
         AND (
           $4::boolean = FALSE
           OR COALESCE((dq.answers->'51'->>'index')::int, (dq.answers->>'51')::int, 0) < 2
         )
         ${school ? 'AND u.school = $5' : ''}
       ORDER BY cs.score DESC
       LIMIT 50`,
      school
        ? [userId, myLookingFor, myGender, smokeFree, school]
        : [userId, myLookingFor, myGender, smokeFree]
    );

    // ── Viability pre-filter (matching-v10 P1) ──────────────────────────────
    // A high compatibility score is noise if two people can't share a lease.
    // Drop candidates on HARD logistics conflicts BEFORE ranking — but only on
    // real, conflicting data: both sides have non-default budgets that don't
    // overlap, or concrete move-in windows >45 days apart. Missing / default
    // (500–2000) / "Flexible" always passes — the pool is thin, so this fails
    // OPEN and never empties a feed on incomplete profiles.
    const meLogistics = {
      budget_min:       meUserRows[0]?.budget_min,
      budget_max:       meUserRows[0]?.budget_max,
      move_in_timeline: meUserRows[0]?.move_in_timeline,
    };
    const mySchool = meUserRows[0]?.school ?? null;
    let feedRows = rows.filter(r => isViable(meLogistics, r).viable);
    // Campus: same-school first, cross-school only as a thin-pool fallback.
    // Skipped when an explicit ?school= filter is already applied (every row is
    // that school), so it can't fight the caller's chosen scope.
    if (!school) feedRows = applyCampusRanking(feedRows, mySchool);

    const matches = feedRows.map(r => buildMatchDTO(r, { me, myAnswers, mySchool }));

    // Part 3 — personalized re-rank. If the viewer has a learned category-weight
    // model (enough real connect/accept/decline history), order their feed by
    // those learned priorities instead of raw compatibility. No model → the feed
    // stays in compat order (today's exact behavior). The DISPLAYED compatScore
    // is never changed — only the order is personalized, so no client change is
    // needed and the pairwise number stays honest for both sides.
    try {
      const weights = await getUserCategoryWeights(userId);
      if (weights) {
        matches.sort((a, b) =>
          personalRankScore(b.breakdown, weights, b.compatScore) -
          personalRankScore(a.breakdown, weights, a.compatScore));
      }
    } catch (e) {
      console.error('[matches/feed] personalize failed:', e.message);
    }

    // Log this serve into pairing_outcomes (features + score), fully DETACHED so
    // it never delays or fails the feed response. Loads pulse_drift for the
    // viewer + candidates to snapshot the #6 trajectory signal (effective
    // velocity + convergence) alongside the answer pairs. We snapshot NOW because
    // answers and drift change; the model must train on what was actually shown.
    (async () => {
      try {
        const driftMap = await loadDrift([userId, ...feedRows.map(r => r.id)]);
        const myDrift = driftMap[String(userId)] || {};
        // Deep-matching #5: snapshot LLM constructs too (consenting users only —
        // loadFeatures returns nothing for users without a stored vector).
        const llmMap = await loadTextInsightFeatures([userId, ...feedRows.map(r => r.id)]);
        const myLlm = llmMap[String(userId)] || null;
        const impressions = feedRows.map(r => ({
          candidateId: r.id,
          score:       parseFloat(r.score),
          features:    buildServeFeatures(
            myAnswers, r.candidate_answers,
            myDrift, driftMap[String(r.id)] || {},
            myLlm, llmMap[String(r.id)] || null),
          school:      req.user.school ?? school ?? null,
        }));
        await recordFeedImpressions(userId, impressions);
      } catch (e) {
        console.error('[matches/feed] impression log failed:', e.message);
      }
    })();

    res.json(matches);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// ── GET /matches/suites ─────────────────────────────────────────────────────
// Deep-matching #4: the best apartment-sized suites at the requester's school,
// each scored by its WEAKEST internal pair (maximin), with the weakest pair
// named. ?size=N = how many suites to return (the card uses 1 and takes
// suites[0]; the full screen uses 3) — NOT the apartment size. Returns
// { suites: [] } whenever the eligible pool can't form even one valid group.
const SUITE_POOL_CAP = 80;
router.get('/suites', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const count = Math.min(10, Math.max(1, parseInt(req.query.size, 10) || 1));

    const { rows: meRows } = await pool.query('SELECT school FROM users WHERE id = $1', [userId]);
    const school = meRows[0]?.school;
    if (!school) return res.json({ suites: [] });

    const includeDemos = isFounderUser(req.user) && process.env.DEMO_FEED === 'true';
    const demoFilter = includeDemos ? '' : `AND ${notDemo('u.email')}`;

    // Eligible pool: same school, quiz done, active, and OPTED IN to matching.
    // (There is no dedicated suite opt-in flag yet — roommate_status is the
    // honest proxy: students who found a roommate are excluded.)
    const { rows: poolRows } = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.photo_url, u.school_year,
              u.gender, u.looking_for, u.dealbreakers, qa.answers
         FROM users u
         JOIN quiz_answers qa ON qa.user_id = u.id
        WHERE u.school = $1
          AND qa.completed = TRUE
          AND u.is_paused = FALSE
          AND u.is_banned = FALSE
          AND COALESCE(u.roommate_status, 'actively_looking') IN ('actively_looking', 'open_to_offers')
          ${demoFilter}
        ORDER BY u.id
        LIMIT ${SUITE_POOL_CAP}`,
      [school],
    );
    if (poolRows.length < 2) return res.json({ suites: [] });

    const ids = poolRows.map(r => r.id);
    // Blocks among the pool — either direction makes that pair invalid.
    const { rows: blockRows } = await pool.query(
      `SELECT blocker_id, blocked_id FROM user_blocks
        WHERE blocker_id = ANY($1::uuid[]) AND blocked_id = ANY($1::uuid[])`,
      [ids],
    );
    const blocked = new Set();
    for (const b of blockRows) {
      blocked.add(`${b.blocker_id}|${b.blocked_id}`);
      blocked.add(`${b.blocked_id}|${b.blocker_id}`);
    }

    // Suites compose on top of the existing pairwise score (#2 + #6 when
    // certified) — load the same models/drift the feed uses, no re-derivation.
    const dimensionModels = await loadCertifiedModels();
    const driftMap = await loadDrift(ids);

    const members = poolRows.map(r => ({
      userId: r.id,
      firstName: r.first_name || '',
      lastInitial: (r.last_name || '').slice(0, 1).toUpperCase(),
      photoUrl: r.photo_url || undefined,
      schoolYear: r.school_year || undefined,
    }));

    const passesPref = (pref, gender) =>
      !Array.isArray(pref) || pref.length === 0 || !gender || gender === 'Prefer not to say' || pref.includes(gender);
    const genderOk = (x, y) => passesPref(x.looking_for, y.gender) && passesPref(y.looking_for, x.gender);

    // Injected pairwise scorer/validator (i < j). A block, a mutual-gender-pref
    // violation, a hard block, or the smoke-free dealbreaker cap (non-smoker ×
    // smoker) makes the pair INVALID → its suite is dropped. Soft caps just make
    // the pair weak, and maximin surfaces that honestly.
    const pairEval = (i, j) => {
      const x = poolRows[i], y = poolRows[j];
      if (blocked.has(`${x.id}|${y.id}`)) return { score: 0, valid: false };
      if (!genderOk(x, y)) return { score: 0, valid: false };
      const dealbreakers = [...new Set([
        ...(Array.isArray(x.dealbreakers) ? x.dealbreakers : []),
        ...(Array.isArray(y.dealbreakers) ? y.dealbreakers : []),
      ])];
      const r = calculateCompatibility(x.answers, y.answers, {
        dealbreakers,
        dimensionModels,
        driftA: driftMap[String(x.id)] || {},
        driftB: driftMap[String(y.id)] || {},
      });
      const valid = !r.isHardBlocked && r.capReason !== 'smoking';
      return { score: r.finalPct, valid, topFrictionTopic: topFrictionTopic(x.answers, y.answers) };
    };

    // Requester-anchored: every returned suite includes the requesting user
    // ("Your best apartment"). Empty if the requester isn't in the eligible pool.
    const suites = buildSuites(members, { pairEval, sizes: [3, 4], count, anchorUserId: userId });
    res.json({ suites });
  } catch (err) {
    console.error('[matches/suites] failed:', err);
    res.status(500).json({ error: 'Failed to build suites' });
  }
});

// ── POST /matches/connect ─────────────────────────────────────────────────
// Send a connect request
// Launch calibration: identical answers = 100; real compatible pairs land
// ~50-60. 65 was too high — it produced ZERO matches for every real user
// (verified 2026-06-08). Must stay in lockstep with the feed threshold in
// the /feed query above. Tune upward as the user base grows and higher-
// compatibility pairs become available.
const CONNECT_MIN_SCORE = MATCH_MIN_SCORE;  // coupled: you can connect to anything you can see
router.post('/connect', requireAuth, refuseBanned, async (req, res) => {
  try {
    const { toUserId } = req.body || {};
    // Type-guard: toUserId must be a non-empty string (UUID). A non-string
    // (array/object/number) would bind oddly into the query and surface as a
    // 500 — reject it cleanly as a 400 instead.
    if (typeof toUserId !== 'string' || !toUserId) return res.status(400).json({ error: 'toUserId required' });
    if (toUserId === req.user.id) {
      return res.status(400).json({ error: 'Cannot connect to yourself' });
    }

    // Eligibility gate — without this, a malicious client can spam
    // connect requests at guessed UUIDs. Require a real compatibility
    // row above the surface threshold AND no hard-block flag.
    const { rows: compat } = await pool.query(
      `SELECT score, is_hard_blocked, breakdown
         FROM compatibility_scores
        WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)
        LIMIT 1`,
      [req.user.id, toUserId]
    );
    if (!compat[0]) {
      return res.status(404).json({ error: 'Match not found' });
    }
    if (compat[0].is_hard_blocked) {
      return res.status(403).json({ error: 'Not eligible to connect' });
    }
    if (parseFloat(compat[0].score) < CONNECT_MIN_SCORE) {
      return res.status(403).json({ error: 'Compatibility too low to connect' });
    }

    // Refuse if either side has blocked the other. Generic error to avoid
    // leaking the existence of a block to the would-be sender ("user not
    // found / eligible" looks the same whether they were blocked or never
    // existed).
    const { rows: blockRows } = await pool.query(
      `SELECT 1 FROM user_blocks
        WHERE (blocker_id = $1 AND blocked_id = $2)
           OR (blocker_id = $2 AND blocked_id = $1)
        LIMIT 1`,
      [req.user.id, toUserId],
    );
    if (blockRows[0]) {
      return res.status(404).json({ error: 'Match not found' });
    }

    // Viability re-check (matching-v10 P1). The feed already pre-filters on hard
    // logistics, but a stale feed, a direct API call, or a profile edited after
    // the feed loaded could still land a non-viable pair here. Re-apply the SAME
    // conservative gate. Fails OPEN — missing / default (500–2000) / 'Flexible'
    // data never blocks; only a genuine hard conflict does.
    const { rows: logi } = await pool.query(
      'SELECT id, budget_min, budget_max, move_in_timeline FROM users WHERE id = $1 OR id = $2',
      [req.user.id, toUserId],
    );
    const meLog   = logi.find(u => u.id === req.user.id) || {};
    const themLog = logi.find(u => u.id === toUserId)    || {};
    const viability = isViable(meLog, themLog);
    if (!viability.viable) {
      return res.status(403).json({
        error: viability.reason === 'budget'
          ? "Your budgets don't overlap enough to share a place."
          : 'Your move-in timelines are too far apart to be roommates.',
        reason: viability.reason,
      });
    }

    // Check if already connected or pending
    const { rows: existing } = await pool.query(
      `SELECT status FROM connect_requests
       WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)`,
      [req.user.id, toUserId]
    );

    if (existing[0]) {
      return res.status(409).json({ error: 'Request already exists', status: existing[0].status });
    }

    await pool.query(
      'INSERT INTO connect_requests (from_user, to_user, status) VALUES ($1, $2, $3)',
      [req.user.id, toUserId, 'pending']
    );

    // Outcome scaffolding: stamp the 'connect' funnel step + snapshot the score
    // and school for later per-school weight-learning. Best-effort, non-blocking.
    recordPairingEvent(req.user.id, toUserId, 'connect', {
      score:  parseFloat(compat[0].score),
      school: req.user.school,
    }).catch(() => {});

    // Part 3 learning loop: log the 'connect' decision with the category
    // breakdown captured now, so per-user weights can be fit later. Best-effort.
    logDecision(req.user.id, toUserId, 'connect', compat[0].breakdown);

    // Recipient-side analytics. The frontend already fires connect_request_sent
    // on the sender; this captures the matching event for the user being
    // contacted so it appears on BOTH users' PostHog timelines.
    analytics.track(analytics.EVENTS.connect_request_received, toUserId, {
      from_user_id: req.user.id,
      score: parseFloat(compat[0].score),
    });

    // Push notification to recipient (fire-and-forget)
    const sendPushToUser = req.app.get('sendPushToUser');
    if (sendPushToUser) {
      const senderName = req.user.first_name || 'Someone';
      sendPushToUser(toUserId, {
        title: 'New connect request ✦',
        body: `${senderName} wants to connect with you on HavenIQ`,
        data: { screen: 'matches' },
      }).catch(err => console.error('[push] connect request send failed:', err));
    }

    // Email the recipient too — push never reaches web users.
    maybeEmailConnectRequest(toUserId, req.user.id, compat[0].score).catch(() => {});

    res.json({ success: true, status: 'pending' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send connect request' });
  }
});

// ── POST /matches/respond ─────────────────────────────────────────────────
// Accept or decline a connect request
router.post('/respond', requireAuth, refuseBanned, async (req, res) => {
  try {
    const { fromUserId, action } = req.body || {}; // action: 'accept' | 'decline'
    // `|| {}` guards a bodyless request (req.body undefined when no JSON sent)
    // from throwing on destructure → 500. fromUserId must be a non-empty string.
    if (typeof fromUserId !== 'string' || !fromUserId || !['accept', 'decline'].includes(action)) {
      return res.status(400).json({ error: 'fromUserId and action (accept|decline) required' });
    }

    const newStatus = action === 'accept' ? 'accepted' : 'declined';
    // Optional, decline-only: a short free-text reason for tuning metadata.
    // Ignored on accept; trimmed/capped/null-coalesced so a missing or junk
    // value never breaks the response.
    const declineReason = action === 'decline' && typeof req.body?.reason === 'string'
      ? (req.body.reason.trim().slice(0, 300) || null)
      : null;

    const { rows } = await pool.query(
      `UPDATE connect_requests
         SET status = $1, updated_at = NOW(),
             decline_reason = CASE WHEN $1 = 'declined' THEN $4 ELSE decline_reason END
       WHERE from_user = $2 AND to_user = $3 AND status = 'pending'
       RETURNING *`,
      [newStatus, fromUserId, req.user.id, declineReason]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'Pending request not found' });
    }

    // Part 3 learning loop: log the responder's accept/decline with the pair's
    // category breakdown, so their per-user weights can learn from real choices.
    // Best-effort and detached — a logging hiccup never affects the response.
    pool.query(
      `SELECT breakdown FROM compatibility_scores
        WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)
        LIMIT 1`,
      [req.user.id, fromUserId],
    ).then(({ rows: cs }) =>
      logDecision(req.user.id, fromUserId, action, cs[0]?.breakdown)
    ).catch(() => {});

    // If accepted, create a conversation and notify the original sender
    if (action === 'accept') {
      const [userA, userB] = req.user.id < fromUserId
        ? [req.user.id, fromUserId]
        : [fromUserId, req.user.id];

      await pool.query(
        // Revive on reconnect: if this pair previously unmatched, the
        // conversation row still exists but is ended_*; clear it so a
        // re-accepted connection can message again (DO NOTHING would leave it
        // ended → "connected but can't message").
        `INSERT INTO conversations (user_a, user_b)
         VALUES ($1, $2)
         ON CONFLICT (user_a, user_b) DO UPDATE
           SET ended_at = NULL, ended_by = NULL`,
        [userA, userB]
      );

      // Outcome scaffolding: a mutual accept is the 'match' funnel step.
      recordPairingEvent(req.user.id, fromUserId, 'match').catch(() => {});

      // Push notification to the person whose request was accepted
      const sendPushToUser = req.app.get('sendPushToUser');
      if (sendPushToUser) {
        const acceptorName = req.user.first_name || 'Someone';
        sendPushToUser(fromUserId, {
          title: 'Connect request accepted! ✦',
          body: `${acceptorName} accepted your connect request. Say hello!`,
          data: { screen: 'messages' },
        }).catch(err => console.error('[push] accept send failed:', err));
      }

      // Real-time in-app moment for the REQUESTER. Push is dead on web (no
      // tokens), so if they're online right now the socket is the only channel
      // that reaches them live — without this they'd just silently see the
      // conversation appear later. Emit to their personal room; the client
      // shows a "you're connected!" celebration + refreshes the journal.
      const io = req.app.get('io');
      if (io) {
        io.to(`user:${fromUserId}`).emit('match_accepted', {
          withUserId: req.user.id,
          withName:   req.user.first_name || 'Someone',
        });
      }

      // First-match parent notification. Fire for BOTH users — each one's
      // parent (if registered) gets a one-time "your student just matched"
      // email. Awaited in the background so the API response stays fast.
      maybeNotifyParent(req.user.id, fromUserId).catch(() => {});
      maybeNotifyParent(fromUserId, req.user.id).catch(() => {});

      // Email the matched student themselves (the original requester). The
      // accepter is active in the app right now; the requester is the one who
      // may be offline and — on web, with no push token — otherwise never
      // learns they matched.
      maybeEmailMatch(fromUserId, req.user.id).catch(() => {});
    }

    // Funnel: a decline is a real decision event — stamp it on pairing_outcomes
    // (accept is stamped as 'match' above). Best-effort, non-blocking.
    if (action === 'decline') {
      recordPairingEvent(req.user.id, fromUserId, 'decline').catch(() => {});
    }

    res.json({ success: true, status: newStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to respond to request' });
  }
});

// ── GET /matches/requests ─────────────────────────────────────────────────
// Incoming pending requests
router.get('/requests', requireAuth, async (req, res) => {
  try {
    // Same DEMO_FEED gate as /feed. Demo connect requests stay hidden for
    // everyone — founder included — unless DEMO_FEED=true is set for an
    // investor demo, where the "incoming requests" tab is populated too.
    const includeDemos = isFounderUser(req.user) && process.env.DEMO_FEED === 'true';
    const demoFilter   = includeDemos ? '' : `AND ${notDemo('u.email')}`;

    const { rows } = await pool.query(
      `SELECT cr.id, cr.from_user, cr.created_at,
              u.first_name, u.last_name, u.school, u.photo_url,
              cs.score
       FROM connect_requests cr
       JOIN users u ON u.id = cr.from_user
       LEFT JOIN compatibility_scores cs ON (
         (cs.user_a = cr.from_user AND cs.user_b = $1) OR
         (cs.user_b = cr.from_user AND cs.user_a = $1)
       )
       WHERE cr.to_user = $1
         AND cr.status = 'pending'
         AND u.is_paused = FALSE
         ${demoFilter}
       ORDER BY cr.created_at DESC`,
      [req.user.id]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// ── GET /matches/:userId/score-history ──────────────────────────────────
// Returns the historical compatibility_scores rows between the caller and
// `userId`, ordered oldest→newest. Powers the Compatibility Timeline
// screen. Each row in this table represents a recomputation (e.g. when
// either party retook the quiz), so the timeline reads as score-over-
// time for this specific pairing.
//
// Returns: Array<{ score, calculated_at }>
router.get('/:userId/score-history', requireAuth, async (req, res) => {
  try {
    const otherId = req.params.userId;
    const meId    = req.user.id;

    // Same gate as openers/explain: only a same-campus or connected pair may
    // read this pairing's score timeline (was ungated — any authed user could
    // pull the score history for an arbitrary pair by id).
    if (!(await mayViewMatchDetail(meId, req.user.school, otherId))) {
      return res.status(403).json({ error: 'not a match' });
    }

    const { rows } = await pool.query(
      `SELECT score, calculated_at
       FROM compatibility_scores
       WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)
       ORDER BY calculated_at ASC`,
      [meId, otherId],
    );

    res.json(rows.map(r => ({
      score:        Number(r.score),
      calculatedAt: r.calculated_at,
    })));
  } catch (err) {
    console.error('score-history failed:', err);
    res.status(500).json({ error: 'Failed to load score history' });
  }
});

// ── POST /matches/:matchId/block ─────────────────────────────────────────
// Permanently block another user. Filter rules elsewhere (feed, messages)
// honor user_blocks rows so the blocker stops seeing this user in either
// direction. UNIQUE (blocker, blocked) makes this idempotent — second
// block is a no-op.
router.post('/:matchId/block', requireAuth, safetyBlock, async (req, res) => {
  try {
    const blockerId = req.user.id;
    const blockedId = req.params.matchId;
    if (!blockedId) return res.status(400).json({ error: 'matchId is required' });
    if (blockedId === blockerId) {
      return res.status(400).json({ error: "You can't block yourself" });
    }
    const reason = typeof req.body?.reason === 'string'
      ? req.body.reason.slice(0, 500)
      : null;

    await pool.query(
      `INSERT INTO user_blocks (blocker_id, blocked_id, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
      [blockerId, blockedId, reason],
    );

    // Soft-cancel any open connect-requests between the two so the UI
    // can't keep surfacing them. Hard delete would lose audit trail.
    await pool.query(
      `UPDATE connect_requests SET status = 'declined', updated_at = NOW()
        WHERE status = 'pending'
          AND ((from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1))`,
      [blockerId, blockedId],
    );

    audit(req, 'user.block', { blocked: blockedId }).catch(() => {});
    analytics.track(analytics.EVENTS.user_blocked, blockerId, { target_user_id: blockedId });
    res.json({ blocked: true });
  } catch (err) {
    console.error('block failed:', err);
    res.status(500).json({ error: 'Could not block user' });
  }
});

// ── DELETE /matches/:matchId/block ───────────────────────────────────────
// Undo a previous block. Useful if the user changes their mind.
router.delete('/:matchId/block', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [req.user.id, req.params.matchId],
    );
    audit(req, 'user.unblock', { blocked: req.params.matchId }).catch(() => {});
    res.json({ blocked: false });
  } catch (err) {
    console.error('unblock failed:', err);
    res.status(500).json({ error: 'Could not unblock user' });
  }
});

// ── POST /matches/:matchId/unmatch ───────────────────────────────────────
// Gracefully disconnect from an accepted match — distinct from block. We
// SOFT-end the conversation (keep the row for safety/audit, e.g. harassment
// after an unmatch), which stops messaging and drops the thread off both
// users' lists. Reversible by design; not hostile like a block. Idempotent:
// re-unmatching an already-ended conversation keeps the FIRST ender + time.
// "Disconnect + allow reconnect" (founder's chosen semantics): END the
// conversation AND reset the connection so the pair shows as a normal,
// connectable match again — either can send a fresh request later, which
// revives the conversation (see the accept handler's ON CONFLICT … ended_at =
// NULL). Reversible + non-punitive; distinct from Block. Compatibility score
// is untouched.
router.post('/:matchId/unmatch', requireAuth, async (req, res) => {
  try {
    const me    = req.user.id;
    const other = req.params.matchId;
    if (!other)        return res.status(400).json({ error: 'matchId is required' });
    if (other === me)  return res.status(400).json({ error: "You can't unmatch yourself" });

    // 1) End the conversation (canonical pair order). COALESCE so a second
    //    unmatch is a no-op that preserves who ended it first + when.
    const [a, b] = me < other ? [me, other] : [other, me];
    const { rows } = await pool.query(
      `UPDATE conversations
          SET ended_at = COALESCE(ended_at, NOW()),
              ended_by = COALESCE(ended_by, $3)
        WHERE user_a = $1 AND user_b = $2
        RETURNING id`,
      [a, b, me],
    );
    if (!rows[0]) return res.status(404).json({ error: 'No conversation to unmatch' });

    // 2) Reset the connection (both directions) so they reappear as a
    //    connectable match and a fresh request won't hit the UNIQUE clash.
    await pool.query(
      `DELETE FROM connect_requests
        WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)`,
      [me, other],
    );

    audit(req, 'match.unmatch', { other }).catch(() => {});
    res.json({ unmatched: true });
  } catch (err) {
    console.error('unmatch failed:', err);
    res.status(500).json({ error: 'Could not unmatch' });
  }
});

// ── POST /matches/:matchId/report ────────────────────────────────────────
// Body: { reason?, category?, severity?, details? }
//
// File a safety report against another user. Persists to user_reports,
// fires a Resend email to the founder for triage, writes an audit row.
// Best-effort on the email so a Resend hiccup never breaks the report.
router.post('/:matchId/report', requireAuth, safetyReport, async (req, res) => {
  try {
    const reporterId = req.user.id;
    const reportedId = req.params.matchId;
    if (!reportedId) return res.status(400).json({ error: 'matchId is required' });

    const {
      reason   = null,
      category = 'other',
      severity = 'medium',
      details  = null,
    } = req.body || {};

    const validCats     = ['harassment', 'spam', 'fake_profile', 'inappropriate_content', 'safety', 'other'];
    const validSevs     = ['low', 'medium', 'high', 'urgent'];
    const safeCat       = validCats.includes(String(category)) ? category : 'other';
    const safeSev       = validSevs.includes(String(severity)) ? severity : 'medium';
    const safeReason    = reason  ? String(reason).slice(0, 200) : null;
    const safeDetails   = details ? String(details).slice(0, 4000) : null;

    const { rows } = await pool.query(
      `INSERT INTO user_reports
         (reporter_id, reported_id, category, severity, reason, details)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [reporterId, reportedId, safeCat, safeSev, safeReason, safeDetails],
    );
    const reportId = rows[0].id;

    // Fire safety alert email to the founder. Fire-and-forget — never
    // block the report response on Resend.
    sendSafetyAlertEmail({
      reportId,
      category:   safeCat,
      severity:   safeSev,
      reason:     safeReason,
      details:    safeDetails,
      reporterId,
      reportedId,
    }).catch(err => console.error('[safety alert email] failed:', err.message));

    audit(req, 'user.report', { reported: reportedId, category: safeCat, severity: safeSev }).catch(() => {});
    analytics.track(analytics.EVENTS.report_submitted, reporterId, {
      target_user_id: reportedId,
      reason: safeCat,
    });
    res.status(201).json({ reported: true, reportId });
  } catch (err) {
    console.error('report failed:', err);
    res.status(500).json({ error: 'Could not file report' });
  }
});

// ── GET /matches/:userId/openers ───────────────────────────────────────
// First-message coach. Returns 3 short, personalized opener suggestions
// the user can tap to insert into their first message to this match.
//
// Why: students freeze at "hey" and conversations die. By surfacing
// 2-3 openers grounded in real shared context (school, major, quiz
// overlap), we tilt the odds toward a real conversation. Drafts only —
// the user reviews + can edit before sending.
//
// Caching: each (viewer, target) pair is cached for 24h so re-opening
// the match doesn't re-bill Claude. Cache invalidates when either
// user updates their profile.
const openerCache = new Map();  // key = `${viewerId}:${targetId}` → { openers, expiresAt }
const OPENER_TTL_MS = 24 * 60 * 60 * 1000;

router.get('/:userId/openers', requireAuth, aiLimiter, async (req, res) => {
  const viewerId = req.user.id;
  // User IDs are UUIDs, not integers — parseInt() turned every real id into
  // NaN, so this endpoint 400'd for every match (and the cache key collapsed
  // to `…:NaN`). Keep the raw string id.
  const targetId = req.params.userId;
  if (!targetId || typeof targetId !== 'string' || targetId === viewerId) {
    return res.status(400).json({ error: 'invalid target user id' });
  }

  // Only generate for someone the viewer could actually room with: same campus,
  // or a pair they've opened a connect request with. Blocks cross-school
  // stranger enumeration (and Claude-budget abuse against arbitrary user ids).
  if (!(await mayViewMatchDetail(viewerId, req.user.school, targetId))) {
    return res.status(403).json({ error: 'not a match' });
  }

  // Cache check
  const cacheKey = `${viewerId}:${targetId}`;
  const cached = openerCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json({ openers: cached.openers, cached: true });
  }

  // Anthropic key must be present
  const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY ?? '').replace(/[^!-~]/g, '');
  if (!ANTHROPIC_KEY) {
    return res.status(503).json({ error: 'Opener coach unavailable (ANTHROPIC_API_KEY not set)' });
  }

  try {
    // Pull both users' profile context. Keep the fields narrow so we
    // never ship something like an email address to the LLM.
    const { rows } = await pool.query(
      `SELECT id, first_name, school, school_year, major, bio
       FROM users
       WHERE id IN ($1, $2)`,
      [viewerId, targetId]
    );
    const me = rows.find((r) => r.id === viewerId);
    const them = rows.find((r) => r.id === targetId);
    if (!me || !them) {
      return res.status(404).json({ error: 'one or both users not found' });
    }

    // Pull quiz answers for both, find overlap on the same questions
    const { agreements: shared } = await loadQuizOverlap(viewerId, targetId);

    const prompt = `You are a coach helping a college student write a great opener for a roommate-matching app. The student is matched with someone they don't know yet. Generate 3 short, real, NOT cringe opener messages they can tap and send.

ME (the sender):
  Name: ${me.first_name ?? '?'}
  School: ${me.school ?? '?'}
  Year: ${me.school_year ?? '?'}
  Major: ${me.major ?? '?'}
  Bio: ${(me.bio ?? '').slice(0, 300) || '(none)'}

THEM (the recipient):
  Name: ${them.first_name ?? '?'}
  School: ${them.school ?? '?'}
  Year: ${them.school_year ?? '?'}
  Major: ${them.major ?? '?'}
  Bio: ${(them.bio ?? '').slice(0, 300) || '(none)'}

SHARED CONTEXT:
  Same school: ${me.school && me.school === them.school ? 'yes' : 'no'}
  Same year: ${me.school_year && me.school_year === them.school_year ? 'yes' : 'no'}
  Same major: ${me.major && me.major === them.major ? 'yes' : 'no'}
  Identical quiz answers on ${shared.length} question(s).

VOICE RULES (this is the difference between good and trash):
- Sound like a real college student texting, not a marketing email.
- No "Hey there!" or "Hi! I noticed we matched". Skip the preamble.
- Reference something specific from their profile or shared context if there's anything to grab.
- One sentence + one question is the format. Open + invite reply.
- No emojis. No exclamation points. Lowercase 'hey' is fine.
- 8-25 words total each.
- ${NO_DASH_RULE}

Output ONLY a JSON array of 3 strings (no markdown fence, no explanation):
["<opener 1>", "<opener 2>", "<opener 3>"]`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':     ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error('[openers] Anthropic call failed:', r.status, txt.slice(0, 200));
      return res.status(502).json({ error: 'Opener generation failed' });
    }
    const j = await r.json();
    const text = (j.content || []).find((b) => b.type === 'text')?.text ?? '[]';

    let openers;
    try {
      openers = JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim());
    } catch {
      openers = [];
    }
    if (!Array.isArray(openers)) openers = [];
    openers = openers.filter((s) => typeof s === 'string' && s.length > 0 && s.length < 300).slice(0, 3).map(stripDashes);

    if (openers.length === 0) {
      return res.status(502).json({ error: 'Opener generation returned no usable suggestions' });
    }

    openerCache.set(cacheKey, { openers, expiresAt: Date.now() + OPENER_TTL_MS });
    res.json({ openers, cached: false });
  } catch (err) {
    console.error('[openers] failed:', err);
    res.status(500).json({ error: 'Opener generation failed' });
  }
});

// ── GET /matches/:userId/explain ───────────────────────────────────────
// Compatibility Explainer. Turns the abstract compatibility score into
// a specific, personal narrative the user actually reads.
//
// The pre-launch test: do users open a match → see "94%" → swipe away,
// or do they open a match → see WHY it's 94% → actually message? This
// is the bot that closes that gap. Renders on Match Detail screen as
// the card between the photo and the compat bars.
//
// Data sources (only data the user gave us):
//   • Both users' quiz answers — find agreement + divergence points
//   • Both users' profile fields (school, year, major, bio)
//   • Both users' synthesized Compatibility Profiles (if available)
//
// 24h server-side cache per (viewer, target) pair. ~$0.05 per
// generation. At 100 users × 10 match-opens/day = ~$50/mo.
const explainerCache = new Map();
const EXPLAIN_TTL_MS = 24 * 60 * 60 * 1000;

router.get('/:userId/explain', requireAuth, aiLimiter, async (req, res) => {
  const viewerId = req.user.id;
  // User IDs are UUIDs, not integers — parseInt() made this 400 for every
  // match. Keep the raw string id (matches /matched/:userId above).
  const targetId = req.params.userId;
  if (!targetId || typeof targetId !== 'string' || targetId === viewerId) {
    return res.status(400).json({ error: 'invalid target user id' });
  }

  // Scope to someone the viewer could actually room with: same campus, or a
  // pair they've opened a connect request with. This is also the one path that
  // reads another user's compatibility profile, so the gate keeps that read off
  // cross-school strangers and stops Claude-budget abuse against arbitrary ids.
  if (!(await mayViewMatchDetail(viewerId, req.user.school, targetId))) {
    return res.status(403).json({ error: 'not a match' });
  }

  const cacheKey = `${viewerId}:${targetId}`;
  const cached = explainerCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json({ ...cached.payload, cached: true });
  }

  const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY ?? '').replace(/[^!-~]/g, '');
  if (!ANTHROPIC_KEY) {
    return res.status(503).json({ error: 'Explainer unavailable (ANTHROPIC_API_KEY not set)' });
  }

  try {
    // Pull both users' profile fields. Strict allowlist — never email,
    // never phone, never address.
    const { rows: userRows } = await pool.query(
      `SELECT id, first_name, school, school_year, major, bio
       FROM users
       WHERE id IN ($1, $2)`,
      [viewerId, targetId]
    );
    const me = userRows.find((r) => r.id === viewerId);
    const them = userRows.find((r) => r.id === targetId);
    if (!me || !them) {
      return res.status(404).json({ error: 'one or both users not found' });
    }

    // Quiz overlap analysis — which questions agree, which diverge?
    const { hasQuizData, agreements, divergences } = await loadQuizOverlap(viewerId, targetId);

    // Synthesized Compatibility Profiles (if either user has one)
    let myProfile = null, theirProfile = null;
    try {
      const { rows: profRows } = await pool.query(
        `SELECT user_id, profile, user_edits
         FROM compatibility_profiles WHERE user_id IN ($1, $2)`,
        [viewerId, targetId]
      );
      const my = profRows.find((r) => r.user_id === viewerId);
      const th = profRows.find((r) => r.user_id === targetId);
      if (my) myProfile = { ...my.profile, ...(my.user_edits || {}) };
      if (th) theirProfile = { ...th.profile, ...(th.user_edits || {}) };
    } catch { /* profile table may not exist yet */ }

    const prompt = `You are HavenIQ's compatibility explainer. The user just opened a match's profile and sees a high compatibility score. Your job: turn the abstract number into specific, true, READABLE narrative that makes them feel "oh, this is actually a fit." Used in the Match Detail screen on a roommate-matching app for California college students.

VIEWER ("me"):
  Name: ${me.first_name}
  School: ${me.school ?? '?'}
  Year: ${me.school_year ?? '?'}
  Major: ${me.major ?? '?'}
  Bio: ${(me.bio ?? '').slice(0, 300) || '(none)'}
  Compatibility profile: ${myProfile ? JSON.stringify({
    archetype: myProfile.roommate_archetype,
    communication: myProfile.communication_style,
    lifestyle: myProfile.lifestyle,
    values: myProfile.values,
  }) : '(not synthesized yet)'}

TARGET ("them"):
  Name: ${them.first_name}
  School: ${them.school ?? '?'}
  Year: ${them.school_year ?? '?'}
  Major: ${them.major ?? '?'}
  Bio: ${(them.bio ?? '').slice(0, 300) || '(none)'}
  Compatibility profile: ${theirProfile ? JSON.stringify({
    archetype: theirProfile.roommate_archetype,
    communication: theirProfile.communication_style,
    lifestyle: theirProfile.lifestyle,
    values: theirProfile.values,
  }) : '(not synthesized yet)'}

QUIZ OVERLAP:
${hasQuizData ? `  Both agreed on ${agreements.length} question(s).
  Diverged on ${divergences.length} question(s).
  Sample agreements: ${agreements.slice(0, 4).map(a => `[${a.category}] "${a.text}" — both chose "${a.both}"`).join(' | ') || 'none'}
  Sample divergences: ${divergences.slice(0, 3).map(d => `[${d.category}] "${d.text}" — you said "${d.you}", they said "${d.them}"`).join(' | ') || 'none'}` : `  Not available — one or both users haven't completed enough of the quiz yet. Do NOT invent, imply, or guess at any quiz-based agreement or tension. "agreements" and "tension_points" must be empty arrays; base "story" only on the compatibility score and the profile fields above.`}

VOICE RULES:
- Sound like a college friend pointing something out, not a marketing email.
- Use first names. Use specific details. NO emojis. NO exclamation points.
- Honesty over flattery — if there's a real difference, name it.
- "Talk about it" framing for divergences, not "this is a red flag" framing.
- NEVER mention question numbers or Q-ids — the user has no idea what those refer to. Use the topic/category instead.
- Every claim in "agreements" and "tension_points" must trace back to something listed in QUIZ OVERLAP above or a profile field above. Never state a specific shared opinion or difference that wasn't actually given to you.
- 50-90 words total in 'story'. Brevity matters.
- ${NO_DASH_RULE}

Return ONLY JSON:
{
  "headline":      "<one short sentence, evocative, no marketing fluff, e.g. 'You two would share a quiet morning well.'>",
  "story":         "<2-3 sentences in the voice above. Uses both first names. References specific shared things. Names ONE specific tension if it exists, framed as 'worth a conversation' not 'concern'.>",
  "agreements":    [{ "topic": "<short label>", "detail": "<one short clause>" }, ...],
  "tension_points":[{ "topic": "<short label>", "you_said": "<your stance>", "they_said": "<their stance>" }, ...],
  "vibe":          "<2-4 word label, lowercase, evocative, e.g. 'low-friction, real talk' or 'quiet anchor energy'>"
}

agreements: up to 3 items, only ones with real signal.
tension_points: 0-2 items, only ones genuinely worth surfacing.
No markdown fence. No explanation outside JSON.`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('[explainer] Anthropic call failed:', r.status, text.slice(0, 200));
      return res.status(502).json({ error: 'Explainer generation failed' });
    }
    const j = await r.json();
    const text = (j.content || []).find((b) => b.type === 'text')?.text ?? '{}';

    let payload;
    try {
      payload = JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim());
    } catch {
      return res.status(502).json({ error: 'Explainer returned unparseable output' });
    }

    // Defensive shape
    payload.headline       = typeof payload.headline === 'string' ? stripDashes(payload.headline.slice(0, 200)) : '';
    payload.story          = typeof payload.story === 'string' ? stripDashes(payload.story.slice(0, 1000)) : '';
    // Hard backstop, not just a prompt instruction: with no real quiz data to
    // draw from, any "agreements"/"tension_points" the model still returned
    // would necessarily be invented, so they're dropped regardless of what
    // it produced.
    payload.agreements     = hasQuizData && Array.isArray(payload.agreements) ? stripDashesDeep(payload.agreements.slice(0, 3)) : [];
    payload.tension_points = hasQuizData && Array.isArray(payload.tension_points) ? stripDashesDeep(payload.tension_points.slice(0, 2)) : [];
    payload.vibe           = typeof payload.vibe === 'string' ? stripDashes(payload.vibe.slice(0, 60)) : '';

    if (!payload.headline || !payload.story) {
      return res.status(502).json({ error: 'Explainer produced empty output' });
    }

    explainerCache.set(cacheKey, { payload, expiresAt: Date.now() + EXPLAIN_TTL_MS });
    res.json({ ...payload, cached: false });
  } catch (err) {
    console.error('[explainer] failed:', err);
    res.status(500).json({ error: 'Explainer generation failed' });
  }
});

// ── GET /matches/:userId ─────────────────────────────────────────────────────
// Single-pair resolver: the full match DTO for ONE other student, by their user
// id. This is the endpoint the app's MatchAPI.getProfile() calls, and it powers
// every path that has a userId but no cached deck row:
//   • a Match-of-the-Day tap or a shared deep link (/match/:id)
//   • a match that has aged out of the live feed
//   • the Messages inbox backfilling a conversation partner's real name + photo
// Without it all of those 404'd — the detail screen showed "match not found" and
// the inbox showed "Your match" over a grey silhouette.
//
// Access is gated by mayViewMatchDetail (same campus, OR an existing connect
// request) — the exact gate /explain and /openers already use — so this can't
// become an arbitrary profile-enumeration endpoint. It mirrors the feed's
// people-level gates (not paused, not banned, quiz done, not hard-blocked,
// neither side has blocked the other) so nobody the feed hides becomes reachable
// here. The one deliberate relaxation vs. the feed is the MATCH_MIN_SCORE cutoff
// and the discovery filters (gender / smoke / demo): a detail lookup by explicit
// id isn't discovery — you already know who you're opening — so an aged-out or
// below-threshold pair must still resolve to the real person.
// UUID guard for the single-pair resolver. This route (added in #9) is mounted
// on '/matches' AHEAD of routes/matchOfTheDay.js and routes/matchedMoment.js, so
// its ':userId' param would otherwise swallow every sibling literal sub-route:
// GET /matches/today bound userId='today', fed "today" into a uuid-typed query,
// and threw 'invalid input syntax for type uuid' → a 500 on EVERY home load
// during cold-start (the bug this fixes). Passing non-UUID params through with
// next() lets Express fall through to the router that actually owns the literal
// path, and permanently prevents this whole collision class.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.get('/:userId', (req, res, next) => {
  // Fall through to the sibling router (e.g. matchOfTheDay's /today) for any
  // non-UUID param, BEFORE auth — this resolver only handles real user ids.
  if (!UUID_RE.test(String(req.params.userId || ''))) return next('route');
  next();
}, requireAuth, async (req, res) => {
  try {
    const viewerId = req.user.id;
    const targetId = req.params.userId;
    if (!targetId || typeof targetId !== 'string' || targetId === viewerId) {
      return res.status(400).json({ error: 'invalid target user id' });
    }
    if (!(await mayViewMatchDetail(viewerId, req.user.school, targetId))) {
      return res.status(403).json({ error: 'not a match' });
    }
    // Block in EITHER direction hides the pair entirely — same as the feed.
    const { rows: blk } = await pool.query(
      `SELECT 1 FROM user_blocks
        WHERE (blocker_id = $1 AND blocked_id = $2)
           OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1`,
      [viewerId, targetId],
    );
    if (blk.length) return res.status(404).json({ error: 'match not found' });

    // Viewer context for the shared DTO mapper (display-only personality
    // pairing, the both-sides friction forecast, the cross-school flag).
    const [{ rows: meRows }, { rows: meUserRows }, { rows: meAnsRows }] = await Promise.all([
      pool.query('SELECT mbti, disc FROM personality_profiles WHERE user_id = $1', [viewerId]),
      pool.query('SELECT school FROM users WHERE id = $1', [viewerId]),
      pool.query('SELECT answers FROM quiz_answers WHERE user_id = $1', [viewerId]),
    ]);
    const me        = meRows[0] || {};
    const mySchool  = meUserRows[0]?.school ?? null;
    const myAnswers = meAnsRows[0]?.answers || null;

    // Exactly the feed's SELECT + JOINs, narrowed to this one pair. No
    // MATCH_MIN_SCORE / gender / smoke / demo discovery filters here (see the
    // route comment) — but the same is_hard_blocked / paused / banned / quiz
    // people-gates, so nothing the feed hides leaks through.
    const { rows } = await pool.query(
      `SELECT
         cs.score,
         cs.is_soft_blocked,
         cs.shadow_penalty,
         cs.breakdown,
         cs.why_matched,
         cs.pre_validation_pct,
         cs.validation_multiplier,
         cs.complementary_dims,
         cs.converging_dims,
         cs.confidence,
         cs.under_pressure,
         dq.answers AS candidate_answers,
         u.id,
         u.first_name,
         u.last_name,
         u.school,
         u.school_year,
         u.major,
         u.bio,
         u.gender,
         u.looking_for,
         u.photo_url,
         u.budget_min,
         u.budget_max,
         u.move_in_timeline,
         u.is_verified,
         u.trust_score,
         u.identity_verified_at,
         u.last_active_at,
         (u.first_name IS NOT NULL AND btrim(u.first_name) <> ''
          AND u.photo_url IS NOT NULL AND btrim(u.photo_url) <> '') AS profile_complete,
         pp.mbti  AS pairing_mbti,
         pp.disc  AS pairing_disc,
         ph.urls  AS photo_urls,
         cr.id     AS connect_request_id,
         cr.status AS connect_status
       FROM compatibility_scores cs
       JOIN users u ON (
         CASE WHEN cs.user_a = $1 THEN cs.user_b ELSE cs.user_a END = u.id
       )
       ${galleryJoin('u.id', 'ph')}
       LEFT JOIN personality_profiles pp ON pp.user_id = u.id
       LEFT JOIN connect_requests cr ON (
         (cr.from_user = $1 AND cr.to_user = u.id) OR
         (cr.to_user = $1   AND cr.from_user = u.id)
       )
       LEFT JOIN quiz_answers dq ON dq.user_id = u.id
       WHERE ((cs.user_a = $1 AND cs.user_b = $2) OR (cs.user_a = $2 AND cs.user_b = $1))
         AND u.id = $2
         AND cs.is_hard_blocked = FALSE
         AND u.is_paused  = FALSE
         AND u.is_banned  = FALSE
         AND u.quiz_completed = TRUE
       LIMIT 1`,
      [viewerId, targetId],
    );
    if (!rows.length) return res.status(404).json({ error: 'match not found' });

    const dto = buildMatchDTO(rows[0], { me, myAnswers, mySchool });
    // Best-effort: a broken trackRecord query must never break match-detail
    // (the badge is a bonus; the match screen is not). Absent on failure,
    // same as when the person just has no earned track record yet.
    try {
      const trackRecord = await computeTrackRecord(targetId);
      if (trackRecord) dto.trackRecord = trackRecord;
    } catch (trErr) {
      console.error('[matches/:userId trackRecord]', trErr.message);
    }
    // Whether BOTH sides have independently self-reported moving in — the
    // stronger bar above a one-sided claim (roommateVouches.js). Omitted
    // (not false) on failure or absence, matching trackRecord's own idiom.
    try {
      const confirmed = await bothMovedInTogether(viewerId, targetId);
      if (confirmed) dto.movedInMutuallyConfirmed = true;
    } catch (mErr) {
      console.error('[matches/:userId movedInMutuallyConfirmed]', mErr.message);
    }

    return res.json(dto);
  } catch (err) {
    console.error('[matches/:userId]', err);
    return res.status(500).json({ error: 'Failed to fetch match' });
  }
});

module.exports = router;
// Exposed for unit tests — this is the cross-repo DTO contract the app's
// stores/matchStore.transformBackendMatch() decodes, shared by the feed and the
// single-pair /:userId resolver. Attaching it to the router keeps HTTP mounting
// (module.exports = router) intact.
module.exports.buildMatchDTO = buildMatchDTO;
