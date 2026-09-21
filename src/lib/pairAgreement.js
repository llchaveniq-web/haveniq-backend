// How closely two students answered each living habit: AGREEMENT only.
//
// The app draws a match as rings: one per habit, longer where the two of you
// answered more alike (the match card's fingerprint and the fit report's
// "Habit by habit"). It computed that from BOTH students' raw quiz answers,
// and the server never sends another student's raw answers (the app promises
// "never your raw answers"). So in production neither picture ever drew:
// every card was a gradient and an initial, and the fit report's ring chart
// was blank.
//
// This computes the same numbers here, where both answer sets already are, and
// sends only them: { label, agreement } per habit, agreement = 100 - |a - b|
// on the app's own 0 to 100 scale. A gap does not say which of you is the tidy
// one, which is the privacy rule the app's utils/pairFingerprint.ts is built
// around; it is the same granularity the fit report's category bars already
// show.
//
// MIRRORS haveniq-app utils/livingProfile.ts buildLivingProfile (question ids,
// value tables, order, the cap of 4) and utils/pairFingerprint.ts
// pairAgreement exactly, so the server's rings and the app's are the same
// picture. Answers are read in the app's wire shape the way the app reads them:
// option -> index, scale -> value - 1 (NOT scoring.js flatten, which keeps a
// scale's raw value).

const DIMS = [
  { label: 'Tidiness',              qid: 50, values: [92, 72, 45, 22] },
  { label: 'Quiet at home',         qid: 53, values: [90, 68, 46, 28] },
  { label: 'Social energy at home', qid: 48, values: [25, 46, 70, 90] },
  { label: 'Up late',               qid: 49, values: [15, 45, 72, 95] },
  { label: 'Follow-through',        qid: 57, values: [90, 68, 45, 30] },
];
const METER_CAP = 4;

function answerIndex(answers, qid) {
  const a = answers && answers[qid];
  if (a == null) return null;
  if (typeof a === 'number') return Number.isInteger(a) ? a : null;
  if (typeof a === 'object') {
    if (a.type === 'option' && Number.isInteger(a.index)) return a.index;
    if (a.type === 'scale' && Number.isFinite(a.value)) return a.value - 1;
  }
  return null;
}

/** buildLivingProfile's meters: first 4 answered habits, in order. */
function livingMeters(answers) {
  const out = [];
  for (const d of DIMS) {
    const i = answerIndex(answers, d.qid);
    if (i === null || i < 0 || i >= d.values.length) continue;
    out.push({ label: d.label, value: d.values[i] });
  }
  return out.slice(0, METER_CAP);
}

/** Habits BOTH answered, in the viewer's order. Never invents a value. */
function pairAgreement(mine, theirs) {
  const a = livingMeters(mine);
  const b = new Map(livingMeters(theirs).map(m => [m.label, m.value]));
  const out = [];
  for (const m of a) {
    if (!b.has(m.label)) continue;
    out.push({ label: m.label, agreement: 100 - Math.abs(m.value - b.get(m.label)) });
  }
  return out;
}

module.exports = { pairAgreement, livingMeters, DIMS };
