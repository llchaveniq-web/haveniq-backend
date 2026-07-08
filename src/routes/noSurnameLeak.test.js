'use strict';

// Guard: the routes that describe ANOTHER student to a viewer (the match feed
// and the conversations list) must never put a full `lastName` in their client
// payload — only the initial. The UI renders "First L." everywhere, so a full
// surname would be an unused field leaking onto another student's device. This
// is what the privacy policy §3 promises. A source scan (not an HTTP test)
// because the payloads are large and the invariant is simply "no lastName key".
// Mirrors the app's noRawSecureStore source-guard pattern.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Payload key = camelCase `lastName:`. The SQL selects use snake_case
// `last_name`, so this pattern only matches a response-object field.
const PAYLOAD_LASTNAME = /\blastName\s*:/;

for (const file of ['matches.js', 'messages.js']) {
  test(`${file}: never ships a full lastName in a client payload (only the initial)`, () => {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.ok(
      !PAYLOAD_LASTNAME.test(src),
      `${file} exposes a full lastName field to another student — send lastInitial instead`,
    );
    // And it must actually surface the initial.
    assert.ok(/\blastInitial\s*:/.test(src), `${file} should expose lastInitial`);
  });
}
