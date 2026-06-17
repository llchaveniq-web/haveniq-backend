// ─── AI prose style helpers ────────────────────────────────────────────────
//
// The founder's house style: NO dashes used as punctuation in any text shown
// to users. LLMs love to join clauses with an em-dash ("you're warm and open —
// people relax around you"); we don't want that anywhere in the app.
//
// Two layers enforce it:
//   1. NO_DASH_RULE — appended to every prose-generating prompt so the model
//      avoids dashes in the first place.
//   2. stripDashes() — a server-side guarantee applied to the model's output
//      before it is returned/stored, because models routinely ignore the rule.
//
// Only dashes used AS PUNCTUATION are replaced. Hyphens inside compound words
// ("move-in", "18-year-old", "co-op") use an unspaced hyphen and are left
// untouched.

// Prompt instruction. Note: deliberately written with zero dashes itself.
const NO_DASH_RULE =
  'PUNCTUATION RULE (important): never use dashes as punctuation. Do not use ' +
  'em-dashes, en-dashes, or a spaced hyphen to join, interrupt, or set off part ' +
  'of a sentence. Use a comma, a period, or a new sentence instead. Hyphens ' +
  'inside compound words like "move-in" or "well-being" are fine.';

// Replace any dash used as punctuation with a comma, then tidy the artifacts.
function stripDashes(text) {
  if (typeof text !== 'string') return text;
  let s = text
    .replace(/\s*—\s*/g, ', ')  // em dash —  (with any surrounding space)
    .replace(/\s*―\s*/g, ', ')  // horizontal bar ―
    .replace(/\s*–\s*/g, ', ')  // en dash –
    .replace(/ +- +/g, ', ');        // a spaced hyphen used as a dash: "a - b"
  // Clean up punctuation artifacts the replacement can create.
  s = s
    .replace(/,\s*,/g, ', ')             // doubled comma
    .replace(/\s+,/g, ',')               // space before comma
    .replace(/,\s*([.!?;:])/g, '$1')     // comma right before end punctuation -> drop comma
    .replace(/([.!?;:])\s*,/g, '$1 ')    // end punctuation then comma -> drop comma
    .replace(/^\s*,\s*/, '')             // leading comma
    .replace(/\s{2,}/g, ' ');            // collapse double spaces
  return s;
}

// Recursively strip dashes from strings inside an object/array (handy for the
// structured JSON the reveal/explainer prompts return).
function stripDashesDeep(value) {
  if (typeof value === 'string') return stripDashes(value);
  if (Array.isArray(value)) return value.map(stripDashesDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = stripDashesDeep(value[k]);
    return out;
  }
  return value;
}

module.exports = { NO_DASH_RULE, stripDashes, stripDashesDeep };
