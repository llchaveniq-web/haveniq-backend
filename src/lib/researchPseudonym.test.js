// researchPseudonym — de-identification for the research export surface.
// Pure unit tests. node --test.
const test = require('node:test');
const assert = require('node:assert');
const { pseudoId, pseudoPairKey, pseudonymizeEvent } = require('./researchPseudonym');

test('the same real id always produces the same pseudonym', () => {
  assert.equal(pseudoId('user-a'), pseudoId('user-a'));
});

test('different real ids produce different pseudonyms', () => {
  assert.notEqual(pseudoId('user-a'), pseudoId('user-b'));
});

test('the pseudonym never contains the real id as a substring', () => {
  assert.ok(!pseudoId('user-a').includes('user-a'));
});

test('a pairKey pseudonymizes to the SAME value regardless of which side sorted first', () => {
  const a = pseudoPairKey(['user-a', 'user-b'].sort().join(':'));
  const b = pseudoPairKey(['user-b', 'user-a'].sort().join(':'));
  assert.equal(a, b, 'pair_key is always canonically sorted before this is called, so this should already hold — belt and suspenders');
});

test('pseudonymizeEvent replaces userId/pairId/pairKey, keeps everything else untouched', () => {
  const pairKey = ['user-a', 'user-b'].sort().join(':');
  const e = {
    id: 'e1', userId: 'user-a', pairId: 'user-b', pairKey,
    t: 100, kind: 'signal', subtype: 'pulse', topic: 'guests',
    value: 2, meta: { raised: true }, episodeId: 'ep-1', arm: 'control', createdAt: 'c1',
  };
  const out = pseudonymizeEvent(e);
  assert.equal(out.id, 'e1');
  assert.equal(out.userId, pseudoId('user-a'));
  assert.equal(out.pairId, pseudoId('user-b'));
  assert.equal(out.pairKey, pseudoPairKey(pairKey));
  assert.equal(out.t, 100);
  assert.equal(out.kind, 'signal');
  assert.equal(out.episodeId, 'ep-1');
  assert.equal(out.arm, 'control');
  assert.deepEqual(out.meta, { raised: true });
});

test('no real id ever appears in a pseudonymized event', () => {
  const out = pseudonymizeEvent({
    id: 'e1', userId: 'user-aaa', pairId: 'user-bbb',
    pairKey: ['user-aaa', 'user-bbb'].sort().join(':'),
    t: 1, kind: 'signal', subtype: 'pulse',
  });
  const body = JSON.stringify(out);
  assert.ok(!body.includes('user-aaa'));
  assert.ok(!body.includes('user-bbb'));
});
