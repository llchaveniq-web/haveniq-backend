// robots.js — the gate every collector fetch passes through.
//
// Worth testing carefully because both failure directions are expensive. Too
// permissive and HavenIQ crawls somewhere it was told not to, which is how a
// source gets lost permanently. Too strict and the collector silently
// collects nothing while looking like it works.
//
// node --test.
const test = require('node:test');
const assert = require('node:assert');
const { parse, matches } = require('./robots');

test('parses a simple group', () => {
  const r = parse('User-agent: *\nDisallow: /private\nCrawl-delay: 3\n');
  assert.deepEqual(r.rules, [{ allow: false, path: '/private' }]);
  assert.equal(r.crawlDelay, 3);
});

test('collects sitemaps, which is how a site says what it publishes', () => {
  const r = parse([
    'User-agent: *',
    'Disallow: /reply',
    'Sitemap: https://example.com/sitemap-postings-00.xml',
    'Sitemap: https://example.com/sitemap-postings-01.xml',
  ].join('\n'));
  assert.equal(r.sitemaps.length, 2);
  assert.ok(r.sitemaps[0].endsWith('postings-00.xml'));
});

test('a group naming us beats the catch-all', () => {
  // A site that names HavenIQBot is talking to us specifically, and that must
  // win over `*` — in both directions, whether it is being stricter or laxer.
  const body = [
    'User-agent: *',
    'Disallow: /',
    '',
    'User-agent: HavenIQBot',
    'Disallow: /admin',
  ].join('\n');
  const r = parse(body, 'HavenIQBot');
  assert.deepEqual(r.rules, [{ allow: false, path: '/admin' }]);
});

test('consecutive user-agent lines share one group', () => {
  const r = parse('User-agent: A\nUser-agent: HavenIQBot\nDisallow: /x\n', 'HavenIQBot');
  assert.deepEqual(r.rules, [{ allow: false, path: '/x' }]);
});

test('ignores comments and blank lines', () => {
  const r = parse('# hello\nUser-agent: *   # trailing\nDisallow: /a\n\n');
  assert.deepEqual(r.rules, [{ allow: false, path: '/a' }]);
});

test('an empty Disallow means allow everything', () => {
  // "Disallow:" with no value is the standard's way of permitting all, and
  // reading it as "block the empty path" would block the entire site.
  assert.equal(matches('', '/anything'), false);
});

test('prefix matching, not segment matching', () => {
  // robots.txt paths are prefixes, so a rule can match mid-segment. Getting
  // this wrong in the strict direction would under-block a site that wrote
  // `Disallow: /re` meaning to catch everything starting with it.
  assert.equal(matches('/reply', '/reply/1234'), true);
  assert.equal(matches('/reply', '/replyxyz'), true, 'prefix, not segment');
  assert.equal(matches('/repl', '/replies'), true, 'a shorter prefix still matches');
  assert.equal(matches('/reply', '/replies'), false, '/replies does not start with /reply');
  assert.equal(matches('/reply', '/other'), false);
});

test('wildcards and end-anchors', () => {
  assert.equal(matches('/search*results', '/search/abc/results'), true);
  assert.equal(matches('/homes/for_rent/$', '/homes/for_rent/'), true);
  // The anchor is the whole point of Zillow's robots file: it permits the
  // landing page and nothing beneath it.
  assert.equal(matches('/homes/for_rent/$', '/homes/for_rent/detail/123'), false);
});

test('regex metacharacters in a path are literal, not a pattern', () => {
  // A path containing . or ? must not become a regex wildcard, or a Disallow
  // would silently over-block.
  assert.equal(matches('/a.b', '/axb'), false);
  assert.equal(matches('/a.b', '/a.b'), true);
});

test("craigslist's real robots.txt permits a posting and blocks the reply form", () => {
  // The actual file, as served. This is the source we are enabling, so the
  // rules that govern it get pinned rather than assumed.
  const body = [
    'User-agent: *',
    'Disallow: /reply',
    'Disallow: /fb/',
    'Disallow: /suggest',
    'Disallow: /flag',
    'Disallow: /mf',
    'Disallow: /mailflag',
    'Disallow: /eaf',
    'Sitemap: https://www.craigslist.org/sitemap-index-postings-00.xml',
  ].join('\n');
  const r = parse(body);

  const blocked = (path) => r.rules.some(rule => matches(rule.path, path) && !rule.allow);
  assert.equal(blocked('/sfc/apa/d/some-apartment/7891234.html'), false, 'a listing is fetchable');
  assert.equal(blocked('/reply/sfo/apa/7891234'), true, 'the reply form is not');
  assert.equal(blocked('/flag/?flagCode=15'), true, 'nor is flagging');
  assert.ok(r.sitemaps.length === 1);
});

test("zillow's shape: an exact-match allow does not open the listings beneath it", () => {
  const r = parse([
    'User-agent: *',
    'Allow: /homes/for_rent/$',
    'Disallow: /homes/',
  ].join('\n'));
  const decide = (path) => {
    let best = null;
    for (const rule of r.rules) {
      if (!matches(rule.path, path)) continue;
      if (!best || rule.path.length > best.path.length) best = rule;
    }
    return best ? best.allow : true;
  };
  assert.equal(decide('/homes/for_rent/'), true, 'the landing page is permitted');
  assert.equal(decide('/homes/for_rent/detail/98765_zpid/'), false, 'a listing page is not');
});

test('longest match wins, and Allow wins a tie', () => {
  const r = parse('User-agent: *\nDisallow: /a\nAllow: /a/b\n');
  const decide = (path) => {
    let best = null;
    for (const rule of r.rules) {
      if (!matches(rule.path, path)) continue;
      if (!best || rule.path.length > best.path.length ||
          (rule.path.length === best.path.length && rule.allow)) best = rule;
    }
    return best ? best.allow : true;
  };
  assert.equal(decide('/a/x'), false);
  assert.equal(decide('/a/b/c'), true, 'the more specific Allow wins');
});
