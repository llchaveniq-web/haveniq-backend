// Template integrity + the honesty guarantee: fixed copy, one per segment, and
// NO numbers in the claim surface (subject + text) — so a lifecycle email can
// never state a fabricated traction/match stat. No DB. node --test.
const test = require('node:test');
const assert = require('node:assert');
const { TEMPLATES, render } = require('./lifecycleTemplates');
const { SEGMENTS } = require('./lifecycleSegments');

test('every segment has a matching frozen template (and vice versa)', () => {
  for (const seg of SEGMENTS) {
    const tpl = TEMPLATES[seg.id];
    assert.ok(tpl, `missing template for segment ${seg.id}`);
    assert.equal(tpl.id, seg.templateId);
    for (const field of ['id', 'segment', 'subject', 'text', 'html']) {
      assert.ok(tpl[field] && String(tpl[field]).length > 0, `${seg.id}.${field} empty`);
    }
  }
});

test('honesty: subject + text contain NO digits (no per-user or fabricated numbers)', () => {
  for (const key of Object.keys(TEMPLATES)) {
    const t = TEMPLATES[key];
    assert.equal(/\d/.test(t.subject), false, `${key} subject has a number: ${t.subject}`);
    assert.equal(/\d/.test(t.text), false, `${key} text has a number`);
  }
});

test('render: substitutes the real first name and leaves no raw token', () => {
  const r = render(TEMPLATES.quiz_incomplete, { firstName: 'Sam' });
  assert.ok(r.text.includes('Hi Sam,'));
  assert.equal(/\{\{firstName\}\}/.test(r.text), false);
  assert.equal(/\{\{firstName\}\}/.test(r.html), false);
});

test('render: missing name → neutral greeting, never an empty/blank name', () => {
  const r = render(TEMPLATES.matches_waiting, {});
  assert.ok(r.text.includes('Hi there,'));
  assert.equal(/\{\{/.test(r.subject + r.text + r.html), false);
});
