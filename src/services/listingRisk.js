/**
 * Listing risk — scam signals on a rental listing, before a student sees it.
 *
 * HavenIQ's landing page promises "no fake listings". That is the entire claim
 * the housing side rests on, and rental fraud is the dominant failure mode in
 * this category: real addresses relisted by someone who doesn't control them,
 * photos lifted from Zillow, a deposit wired to someone who is "currently
 * abroad". For most marketplaces a bad listing is an annoyance. Here it is the
 * product, and a student who loses a deposit to a listing HAVENIQ SHOWED THEM
 * doesn't churn quietly — they tell their whole campus.
 *
 * DELIBERATELY RULE-BASED, NOT AN LLM CALL.
 *
 * The signals below are the ones that actually correlate with fraud, and every
 * one of them is a rule: a payment method, a phrase, a price that can't be
 * real. Rules are auditable, free, instant, deterministic, and can't be talked
 * out of a verdict by text inside the listing itself — which matters, because
 * the listing body is attacker-controlled input. An LLM belongs on the fuzzy
 * residue AFTER this, not in front of it.
 *
 * What this CANNOT do, and no classifier can: tell you whether the poster
 * actually controls the unit. That is the thing that matters most, and it is
 * why the output is a recommendation for a human queue rather than a verdict
 * that auto-publishes.
 *
 * PURE. No DB, no network, no clock. The caller decides what to do with the
 * verdict.
 */

/** Weights are ordered by how strongly each signal predicts fraud, not by how
 *  common it is. A wire-transfer demand is near-dispositive; a missing photo is
 *  a nudge. */
const SIGNALS = [
  {
    id: 'offsite_payment',
    weight: 55,
    label: 'Asks for wire transfer, gift cards or a cash app',
    // The single most reliable tell in rental fraud: an irreversible payment
    // rail requested before a viewing. Legitimate landlords take a check, a
    // card, or a portal payment — all of which can be clawed back.
    test: ({ text }) => /\b(wire transfer|western union|moneygram|zelle|cash ?app|venmo|gift ?card|bitcoin|crypto|btc|money order)\b/i.test(text),
  },
  {
    id: 'remote_landlord',
    weight: 40,
    label: 'Landlord claims to be away and unable to show the unit',
    // Pairs with offsite_payment in almost every documented scam: the reason
    // you can't see it is the reason you must pay first.
    test: ({ text }) => /\b(out of (the )?country|abroad|overseas|missionary|military deployment|currently (in|out of)|can(no|')t show|unable to show|no (in.?person )?(viewing|showing)s?)\b/i.test(text),
  },
  {
    id: 'keys_by_mail',
    weight: 35,
    label: 'Offers to mail keys or rent sight-unseen',
    test: ({ text }) => /\b(mail (you )?the keys|ship the keys|keys by (mail|post)|sight.?unseen|rent before (you )?see)\b/i.test(text),
  },
  {
    id: 'deposit_before_viewing',
    weight: 30,
    label: 'Wants a deposit or application fee before any viewing',
    test: ({ text }) => /\b(deposit|first month|application fee|holding fee)\b[^.!?]{0,60}\b(before|prior to|to (secure|reserve|hold))\b/i.test(text),
  },
  {
    id: 'implausible_rent',
    weight: 30,
    label: 'Rent is far below anything real for this market',
    // Not a market comparison — a floor. Sub-$250/person for a whole unit near
    // a US campus is not a bargain, it is bait. Deliberately crude: a real
    // market comparison needs data this backend doesn't have, and a wrong
    // "below market" flag on a genuinely cheap room would suppress exactly the
    // listings students most need.
    test: ({ perPersonRent }) => perPersonRent != null && perPersonRent > 0 && perPersonRent < 250,
  },
  {
    id: 'urgency_pressure',
    weight: 20,
    label: 'Pressures for an immediate decision',
    test: ({ text }) => /\b(act fast|urgent|asap|today only|first come first serve|serious (inquiries|renters) only|don'?t miss)\b/i.test(text),
  },
  {
    id: 'contact_offsite',
    weight: 20,
    label: 'Pushes the conversation to an outside channel immediately',
    test: ({ text }) => /\b(text me at|whats ?app|telegram|email me directly at|contact me on)\b/i.test(text),
  },
  {
    id: 'no_contact',
    weight: 15,
    label: 'No way to reach anyone about the listing',
    test: ({ contactEmail, contactPhone }) => !contactEmail && !contactPhone,
  },
  {
    id: 'no_photo',
    weight: 10,
    label: 'No photo',
    test: ({ photoUrl }) => !photoUrl,
  },
  {
    id: 'thin_address',
    weight: 25,
    label: 'Address is too vague to identify a real place',
    // A street number is the cheapest possible proof that a specific unit is
    // being described rather than a plausible-sounding area.
    test: ({ address }) => !address || !/\d/.test(address) || address.trim().length < 8,
  },
];

/** Everything a signal can look at, normalised once.
 *
 *  `|| {}` rather than a default parameter: a default only fires on undefined,
 *  and null is the shape that actually arrives from a database column or a
 *  JSON body. Getting that wrong crashes the scorer on exactly the malformed
 *  listing it exists to catch. */
function surface(listing) {
  listing = listing || {};
  const text = [listing.notes, listing.description, listing.title, listing.contactName]
    .filter(v => typeof v === 'string')
    .join('\n');
  return {
    text,
    address: typeof listing.address === 'string' ? listing.address : '',
    perPersonRent: listing.perPerson ?? null,
    photoUrl: listing.photoUrl || null,
    contactEmail: listing.contactEmail || null,
    contactPhone: listing.contactPhone || null,
  };
}

/**
 * Assess a listing.
 *
 * Returns { score, signals, recommendation }.
 *
 *   publish — nothing suspicious. Still only used where the source is already
 *             trusted; a clean score is not evidence the poster owns the unit.
 *   review  — a human looks before a student does. THE DEFAULT for anything
 *             uncertain, including a listing this function fails to understand.
 *   reject  — signals that essentially never co-occur with a real listing.
 *
 * Note the asymmetry with photoSafety's soft-fail: that one fails OPEN, because
 * blocking a real user during a Claude outage is worse than letting a photo
 * through. This fails to REVIEW, because publishing a scam is worse than making
 * a founder click approve. Same principle, opposite direction — the cost of a
 * false negative is what sets it.
 */
function assessListing(listing) {
  const s = surface(listing);

  const hits = SIGNALS.filter(sig => {
    try { return sig.test(s); } catch { return false; }
  }).map(({ id, weight, label }) => ({ id, weight, label }));

  const score = Math.min(100, hits.reduce((n, h) => n + h.weight, 0));

  // The combination, not just the total, is what convicts. "Away and can't
  // show" plus "wire me the deposit" is the archetypal scam and should never
  // reach a student regardless of how the weights happen to sum.
  const ids = new Set(hits.map(h => h.id));
  const fatalPair = ids.has('offsite_payment') &&
    (ids.has('remote_landlord') || ids.has('keys_by_mail') || ids.has('deposit_before_viewing'));

  let recommendation = 'publish';
  if (score >= 20) recommendation = 'review';
  if (score >= 70 || fatalPair) recommendation = 'reject';

  return { score, signals: hits, recommendation, fatalPair };
}

module.exports = { assessListing, SIGNALS };
