'use strict';

// Contract test for buildMatchDTO — the single mapping shared by GET /matches/feed
// and GET /matches/:userId. Its output keys are consumed verbatim by the app's
// stores/matchStore.transformBackendMatch(); this locks that contract so the two
// endpoints can never drift and a rename can't silently blank a match card.

process.env.JWT_SECRET = process.env.JWT_SECRET
  || require('crypto').randomBytes(48).toString('hex');

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMatchDTO } = require('./matches');

// A fully-populated scored row, in the shape the feed's SELECT produces.
function fullRow(overrides = {}) {
  return {
    score: '87.5',
    is_soft_blocked: false,
    shadow_penalty: '0',
    breakdown: { 'daily habits': 90 },
    why_matched: 'You both keep quiet nights.',
    pre_validation_pct: null,
    validation_multiplier: null,
    complementary_dims: null,
    converging_dims: null,
    confidence: '1',
    under_pressure: null,
    candidate_answers: null,
    id: 'target-uuid',
    first_name: 'Maya',
    last_name: 'Chen',
    school: 'UCLA',
    school_year: 'Sophomore',
    major: 'Business',
    bio: 'Tidy, early riser.',
    gender: 'Female',
    looking_for: ['Female'],
    photo_url: 'https://example.test/maya.jpg',
    budget_min: 800,
    budget_max: 1400,
    move_in_timeline: 'Fall',
    is_verified: true,
    trust_score: 40,
    identity_verified_at: '2026-01-01T00:00:00.000Z',
    last_active_at: '2026-07-27T00:00:00.000Z',
    profile_complete: true,
    pairing_mbti: 'INFJ',
    pairing_disc: 'S',
    photo_urls: null,
    connect_request_id: null,
    connect_status: null,
    ...overrides,
  };
}

test('buildMatchDTO maps the core identity + score fields the app reads', () => {
  const dto = buildMatchDTO(fullRow(), { me: { mbti: 'ENFP', disc: 'I' }, myAnswers: null, mySchool: 'UCLA' });

  assert.equal(dto.userId, 'target-uuid');
  assert.equal(dto.firstName, 'Maya');
  // Only the initial ever leaves the server — never the raw surname.
  assert.equal(dto.lastInitial, 'C');
  assert.ok(!('lastName' in dto), 'raw last name must never be in the DTO');
  assert.equal(dto.compatScore, 87.5);            // numeric, not the '87.5' string
  assert.equal(dto.school, 'UCLA');
  assert.equal(dto.photoUrl, 'https://example.test/maya.jpg');
  assert.deepEqual(dto.photos, ['https://example.test/maya.jpg']); // gallery falls back to photo_url
  assert.equal(dto.profileComplete, true);
  assert.equal(dto.confidence, 1);
  assert.equal(dto.isProvisional, false);
  assert.equal(dto.crossSchool, false);           // same school as viewer
});

test('buildMatchDTO flags a cross-school pair against the viewer campus', () => {
  const dto = buildMatchDTO(fullRow({ school: 'USC' }), { mySchool: 'UCLA' });
  assert.equal(dto.crossSchool, true);
});

test('buildMatchDTO OMITS the honesty-gated sections when there is no real signal', () => {
  const dto = buildMatchDTO(fullRow(), { mySchool: 'UCLA' });
  // A neutral 1.0 multiplier must NOT surface a "validated" badge (trust fraud).
  assert.ok(!('validationMultiplier' in dto));
  assert.ok(!('preValidationPct' in dto));
  assert.ok(!('complementaryDims' in dto));
  assert.ok(!('convergingDims' in dto));
  assert.ok(!('topFrictions' in dto));
  assert.ok(!('underPressure' in dto));
});

test('buildMatchDTO SURFACES validation + complementarity only with real signal', () => {
  const dto = buildMatchDTO(
    fullRow({ validation_multiplier: '1.1', pre_validation_pct: 80, complementary_dims: [{ qid: 3 }] }),
    { mySchool: 'UCLA' },
  );
  assert.equal(dto.validationMultiplier, 1.1);
  assert.equal(dto.preValidationPct, 80);
  assert.deepEqual(dto.complementaryDims, [{ qid: 3 }]);
});

test('buildMatchDTO is provisional when confidence < 1', () => {
  const dto = buildMatchDTO(fullRow({ confidence: '0.6' }), { mySchool: 'UCLA' });
  assert.equal(dto.confidence, 0.6);
  assert.equal(dto.isProvisional, true);
});

test('buildMatchDTO passes a blank score through as a number (app owns the NaN→0 coercion)', () => {
  // parseFloat('') === NaN. The DTO carries the raw parse; the app's
  // transformBackendMatch does the final Number.isFinite → 0 guard. This
  // documents WHERE that coercion lives so neither side double-guesses it.
  const dto = buildMatchDTO(fullRow({ score: '' }), { mySchool: 'UCLA' });
  assert.equal(typeof dto.compatScore, 'number');
  assert.ok(Number.isNaN(dto.compatScore));
});
