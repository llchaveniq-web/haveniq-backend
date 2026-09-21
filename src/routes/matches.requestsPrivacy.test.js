// GET /matches/requests lists people who asked to connect and have NOT been
// accepted. The app promises their last name and photo stay hidden until both
// connect ("others see only your first name and initial"). The query returned
// u.last_name and u.photo_url raw; /feed and match of the day already sent
// only the initial. Reads the handler's SQL. node --test.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'matches.js'), 'utf8');
const start = src.indexOf("router.get('/requests'");
const handler = src.slice(start, src.indexOf('router.', start + 20));

test('found the /requests handler', () => {
  assert.ok(start > 0 && handler.includes('FROM connect_requests'));
});

test('it sends the last initial, never the last name', () => {
  assert.ok(/AS last_initial/.test(handler));
  // Selected on its own. Inside LEFT(COALESCE(u.last_name, ...)) it is the
  // initial, which is the point.
  assert.equal(/(^|[^(])u\.last_name\s*,/m.test(handler), false);
});

test('it sends no photo of someone not yet accepted', () => {
  assert.equal(/photo_url/.test(handler.replace(/\/\/.*$/gm, '')), false);
});
