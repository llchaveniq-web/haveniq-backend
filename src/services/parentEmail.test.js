// The parent match email states a compatibility number about someone's child.
// The score comes from a LEFT JOIN, so it can be null — and Number(null) is 0,
// which used to render "0% compatibility". Outward-facing, so it must either be
// right or absent. Resend stubbed; asserts on the generated HTML. node --test.
const test = require('node:test');
const assert = require('node:assert');

function inject(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const sent = [];
inject('resend', { Resend: class { constructor() { this.emails = { send: async (m) => { sent.push(m); return { id: 'x' }; } }; } } });
process.env.RESEND_API_KEY = 'test_key';

const email = require('./email');

const base = {
  parentEmail: 'parent@example.com',
  studentName: 'Jordan',
  matchName: 'Maya R.',
  matchSchool: 'Ohio University',
};

test.beforeEach(() => { sent.length = 0; });

test('a real score is stated', async () => {
  await email.sendParentMatchEmail({ ...base, compatibilityPct: 87 });
  assert.match(sent[0].html, /87% compatibility · Ohio University/);
});

test('a NULL score omits the percentage instead of claiming 0%', async () => {
  await email.sendParentMatchEmail({ ...base, compatibilityPct: null });
  const html = sent[0].html;
  assert.ok(!/0% compatibility/.test(html), 'must never tell a parent their child matched at 0%');
  assert.ok(!/null%|NaN%|undefined%/.test(html), 'and must not leak a placeholder');
  assert.match(html, /Ohio University/, 'the school still shows — we say less, not nothing');
});

test('an undefined score behaves the same', async () => {
  await email.sendParentMatchEmail({ ...base, compatibilityPct: undefined });
  assert.ok(!/(0|null|NaN|undefined)% compatibility/.test(sent[0].html));
});

test('a genuine 0 is not confused with a missing score', async () => {
  // If a pair really scored 0, that is a fact and may be stated.
  await email.sendParentMatchEmail({ ...base, compatibilityPct: 0 });
  assert.match(sent[0].html, /0% compatibility/);
});

test('the match name and student name still render', async () => {
  await email.sendParentMatchEmail({ ...base, compatibilityPct: 72 });
  assert.match(sent[0].html, /Jordan just matched with Maya R\./);
});
