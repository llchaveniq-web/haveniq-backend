// listingRisk — scam signals on a rental listing.
//
// Two failure directions, and they cost very different amounts:
//
//   FALSE NEGATIVE — a scam reaches a student. HavenIQ's landing page promises
//     "no fake listings", and a student who loses a deposit to a listing the
//     app showed them tells their whole campus. This is the expensive one, and
//     most of the tests below are about it.
//
//   FALSE POSITIVE — a real cheap room gets held for review. Costs a founder
//     one click. Cheap, but not free: over-flagging would suppress exactly the
//     listings students most need, so the genuinely-fine cases are pinned too.
//
// node --test.
const test = require('node:test');
const assert = require('node:assert');

const { assessListing } = require('./listingRisk');

const CLEAN = {
  address: '412 Bardeen Ave',
  perPerson: 950,
  photoUrl: 'https://example.com/a.jpg',
  contactEmail: 'landlord@example.com',
  contactPhone: '555-0100',
  notes: 'Two bedroom near campus, available for the fall term. Laundry in unit.',
};

const ids = (r) => r.signals.map(s => s.id).sort();

test('a normal listing passes clean', () => {
  const r = assessListing(CLEAN);
  assert.deepEqual(r.signals, []);
  assert.equal(r.score, 0);
  assert.equal(r.recommendation, 'publish');
});

test('the archetypal scam is rejected outright', () => {
  // "I'm abroad, wire me the deposit, I'll mail the keys." This exact shape is
  // the most-documented rental fraud there is and must never reach a student,
  // no matter how the weights happen to add up.
  const r = assessListing({
    ...CLEAN,
    notes: 'I am currently out of the country on a missionary trip so I cannot show the unit. '
         + 'Send the deposit by wire transfer and I will mail you the keys.',
  });
  assert.equal(r.recommendation, 'reject');
  assert.equal(r.fatalPair, true);
});

test('the fatal pair convicts even when the score alone would not', () => {
  // offsite_payment (55) + deposit_before_viewing (30) is over threshold anyway,
  // so use the weakest qualifying partner to prove the PAIR is doing the work.
  const r = assessListing({
    ...CLEAN,
    notes: 'Please send a deposit by Zelle to reserve it. I will mail the keys once it clears.',
  });
  assert.equal(r.fatalPair, true);
  assert.equal(r.recommendation, 'reject');
});

test('detects each irreversible payment rail by name', () => {
  for (const rail of ['wire transfer', 'Western Union', 'MoneyGram', 'Zelle', 'Cash App',
                      'venmo', 'gift card', 'Bitcoin', 'money order']) {
    const r = assessListing({ ...CLEAN, notes: `Payment by ${rail} only.` });
    assert.ok(ids(r).includes('offsite_payment'), `missed: ${rail}`);
  }
});

test('a normal payment method is NOT a signal', () => {
  // Over-flagging suppresses real listings. Cheque, card and portal payments
  // are all reversible and all ordinary.
  for (const ok of ['Pay by check', 'Rent paid through the tenant portal',
                    'Card payments accepted', 'Direct deposit to the management company']) {
    const r = assessListing({ ...CLEAN, notes: ok });
    assert.ok(!ids(r).includes('offsite_payment'), `false positive: ${ok}`);
  }
});

test('flags an impossible rent, but not a merely cheap one', () => {
  // $200/person for a whole unit near a US campus is bait. $400 is a real
  // room, and flagging it would bury the listings students most want.
  assert.ok(ids(assessListing({ ...CLEAN, perPerson: 200 })).includes('implausible_rent'));
  assert.ok(!ids(assessListing({ ...CLEAN, perPerson: 400 })).includes('implausible_rent'));
  assert.ok(!ids(assessListing({ ...CLEAN, perPerson: 250 })).includes('implausible_rent'));
});

test('a missing rent is not treated as a rent of zero', () => {
  // null perPerson would otherwise satisfy "< 250" and flag every listing that
  // simply hasn't filled the field in.
  assert.ok(!ids(assessListing({ ...CLEAN, perPerson: null })).includes('implausible_rent'));
  assert.ok(!ids(assessListing({ ...CLEAN, perPerson: 0 })).includes('implausible_rent'));
});

test('flags an address too vague to be a real place', () => {
  for (const bad of ['Near campus', 'Westwood area', '', undefined, 'Apt']) {
    assert.ok(ids(assessListing({ ...CLEAN, address: bad })).includes('thin_address'), `missed: ${bad}`);
  }
  assert.ok(!ids(assessListing({ ...CLEAN, address: '412 Bardeen Ave' })).includes('thin_address'));
});

test('flags a listing with no way to contact anyone', () => {
  const r = assessListing({ ...CLEAN, contactEmail: null, contactPhone: null });
  assert.ok(ids(r).includes('no_contact'));
  // Either one alone is enough to reach someone.
  assert.ok(!ids(assessListing({ ...CLEAN, contactPhone: null })).includes('no_contact'));
  assert.ok(!ids(assessListing({ ...CLEAN, contactEmail: null })).includes('no_contact'));
});

test('a single soft signal is reviewed, not rejected', () => {
  // A missing photo is a nudge, not an accusation. Rejecting on it would throw
  // away real listings from landlords who just did not upload one.
  const r = assessListing({ ...CLEAN, photoUrl: null, notes: 'Urgent, act fast!' });
  assert.equal(r.recommendation, 'review');
});

test('no photo alone does not even reach review', () => {
  const r = assessListing({ ...CLEAN, photoUrl: null });
  assert.equal(r.score, 10);
  assert.equal(r.recommendation, 'publish');
});

test('signal text is attacker-controlled and must not crash the scorer', () => {
  // The listing body comes from whoever posted it. Regex-hostile input, huge
  // strings and wrong types must all degrade to a verdict, never an exception.
  const nasty = [
    { notes: 'a'.repeat(100000) },
    { notes: '((((((((((' },
    { notes: 12345 },
    { address: { toString() { throw new Error('boom'); } } },
    { perPerson: 'free' },
    {},
    null,
    undefined,
  ];
  for (const bad of nasty) {
    assert.doesNotThrow(() => assessListing(bad), `threw on ${JSON.stringify(bad)}`);
  }
});

test('an empty listing is held for review, never published', () => {
  // The safe default. A listing we understand nothing about is exactly the one
  // a human should see first.
  const r = assessListing({});
  assert.equal(r.recommendation, 'review');
});

test('score is capped and never negative', () => {
  const r = assessListing({
    address: '', perPerson: 1, photoUrl: null, contactEmail: null, contactPhone: null,
    notes: 'Urgent! I am abroad and cannot show it. Wire transfer only, I will mail the keys. '
         + 'Send a deposit to reserve. Text me on WhatsApp.',
  });
  assert.ok(r.score <= 100);
  assert.ok(r.score >= 0);
  assert.equal(r.recommendation, 'reject');
});

test('every signal carries a human-readable label for the review queue', () => {
  // A founder triaging the queue needs to know WHY, not see an opaque id.
  const r = assessListing({ ...CLEAN, notes: 'Wire transfer only, I am overseas.' });
  assert.ok(r.signals.length > 0);
  for (const sig of r.signals) {
    assert.equal(typeof sig.label, 'string');
    assert.ok(sig.label.length > 10, `unhelpful label: ${sig.label}`);
    assert.equal(typeof sig.weight, 'number');
  }
});
