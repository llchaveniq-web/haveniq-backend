'use strict';

// Locks the AI coach's grounding constraints so a future prompt edit can't
// silently drop them. The coach is the last link between the honest matching
// engine and what a student reads — without these rules it can fabricate a
// compatibility reason or speak with false certainty about a provisional score,
// undoing every honesty layer the UI carefully builds.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PERSONAS } = require('./knowledgeAgent');

test('advisor persona: forbids inventing a reason/score/match beyond the context', () => {
  const p = PERSONAS.advisor.toLowerCase();
  // Must explicitly bar fabricating compatibility specifics.
  assert.ok(
    p.includes('invent a compatibility reason'),
    'advisor prompt must forbid inventing a compatibility reason/score/match',
  );
  // Must prefer honesty ("reasons aren't in front of you") over a manufactured
  // psychological-sounding explanation.
  assert.ok(
    p.includes('manufacture'),
    'advisor prompt must tell the coach not to manufacture an explanation',
  );
});

test('advisor persona: treats an early-read/provisional score as still forming', () => {
  const p = PERSONAS.advisor.toLowerCase();
  assert.ok(p.includes('provisional'), 'advisor prompt must name provisional scores');
  assert.ok(
    p.includes('early read') || p.includes('still learning'),
    'advisor prompt must recognize the early-read / still-learning framing',
  );
});
