/**
 * robots.txt — fetch, parse, cache, obey.
 *
 * Every collector fetch goes through isAllowed() first. Not as a courtesy:
 * robots.txt is the machine-readable statement of what a site permits, and
 * respecting it is the difference between a crawler and something that has to
 * hide what it is. HavenIQ's collector identifies itself in its User-Agent and
 * stops where it is told to stop. When a source refuses us we lose that source,
 * which is a decision for a human, not something to route around.
 *
 * Deliberately small: group matching on User-Agent, Allow/Disallow with the
 * longest-match-wins rule from the standard, Crawl-delay, and Sitemap
 * collection. No wildcards beyond `*` and `$`, which is all real robots files
 * in this space use.
 *
 * FAILS CLOSED on an unreadable robots.txt. A 404 means "no restrictions" and
 * is treated as allow — that IS the standard — but a timeout, a 5xx, or an
 * Access Denied page means we could not learn the rules, and crawling a site
 * whose rules we could not read is exactly the behaviour this file exists to
 * prevent.
 */

const UA = 'HavenIQBot';
const TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // re-check twice a day

const cache = new Map();   // origin -> { rules, fetchedAt }

/** Parse a robots.txt body into the rules that apply to `ua`. */
function parse(body, ua = UA) {
  const lines = String(body).split(/\r?\n/);
  const groups = [];          // { agents: [], rules: [], crawlDelay }
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'sitemap') { sitemaps.push(value); continue; }

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group, per the standard.
      if (!current || !lastWasAgent) { current = { agents: [], rules: [], crawlDelay: null }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;

    if (field === 'allow' || field === 'disallow') {
      current.rules.push({ allow: field === 'allow', path: value });
    } else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }

  // Most specific group wins: our own name over `*`. A site that names us
  // explicitly is talking to us, and that beats the catch-all.
  const lower = ua.toLowerCase();
  const named = groups.find(g => g.agents.some(a => a !== '*' && lower.includes(a)));
  const star = groups.find(g => g.agents.includes('*'));
  const group = named || star || { rules: [], crawlDelay: null };

  return { rules: group.rules, crawlDelay: group.crawlDelay, sitemaps };
}

/** Does a robots path pattern match this URL path? Supports `*` and `$`. */
function matches(pattern, path) {
  if (pattern === '') return false;          // an empty Disallow means "allow all"
  const anchored = pattern.endsWith('$');
  const p = anchored ? pattern.slice(0, -1) : pattern;
  const rx = '^' + p.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : '');
  try { return new RegExp(rx).test(path); } catch { return false; }
}

/**
 * The rules for an origin. Returns null when they could not be read, which
 * callers must treat as "do not crawl".
 */
async function getRules(origin) {
  const hit = cache.get(origin);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.rules;

  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': `${UA} (+https://haveniq.org/bot)` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    let rules;
    if (res.status === 404 || res.status === 410) {
      // No robots.txt is an explicit "no restrictions" in the standard.
      rules = { rules: [], crawlDelay: null, sitemaps: [] };
    } else if (!res.ok) {
      // 403 / 5xx / an Access Denied page. We did not learn the rules.
      return null;
    } else {
      const body = await res.text();
      // Some sites answer robots.txt with an HTML error page and a 200.
      if (/^\s*</.test(body)) return null;
      rules = parse(body);
    }

    cache.set(origin, { rules, fetchedAt: Date.now() });
    return rules;
  } catch {
    return null;
  }
}

/**
 * May we fetch this URL?
 *
 * Longest matching pattern wins; Allow beats Disallow at equal length, per the
 * standard. Anything we could not read is a no.
 */
async function isAllowed(url) {
  let u;
  try { u = new URL(url); } catch { return { allowed: false, reason: 'bad url' }; }

  const rules = await getRules(u.origin);
  if (!rules) return { allowed: false, reason: 'robots.txt unreadable' };

  const path = u.pathname + (u.search || '');
  let best = null;
  for (const r of rules.rules) {
    if (!matches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }

  return {
    allowed: best ? best.allow : true,
    reason: best ? `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}` : 'no matching rule',
    crawlDelay: rules.crawlDelay,
  };
}

/** Sitemaps a site advertises — the polite way to enumerate what it publishes. */
async function getSitemaps(origin) {
  const rules = await getRules(origin);
  return rules ? rules.sitemaps : [];
}

module.exports = { isAllowed, getSitemaps, getRules, parse, matches, UA };
