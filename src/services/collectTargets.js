/**
 * Parse COLLECT_TARGETS into collector targets.
 *
 * Format:  source:region:school  — several separated by ';' (or ',')
 *
 *     COLLECT_TARGETS=uloop:usc:University of Southern California;craigslist:orc:Orange Coast College
 *
 * WHY THE SEMICOLON. School names contain commas — "University of California,
 * Los Angeles" is the canonical name the app stores — so a comma-separated
 * list truncates it to "University of California" and drops " Los Angeles" as
 * a malformed entry. It fails silently and looks like it worked: the collector
 * happily files listings under a school no student has, and the housing tab
 * stays empty with nothing in the logs to explain why.
 *
 * Commas still work for values that contain none, so existing config keeps
 * running; the separator is chosen per-value rather than by a flag day.
 *
 * This lives in its own module because it was inline in server.js, where the
 * only way to find out it was wrong was to deploy it.
 */

/**
 * -> { targets, rejected }, skipping anything malformed.
 *
 * `school` keeps any colons it contained; only the first two are structural.
 * `rejected` is returned so a caller can say what it refused out loud rather
 * than quietly collecting less than it was asked to.
 */
function parseCollectTargets(raw) {
  const s = String(raw || '');
  const semi = s.includes(';');
  const parts = (semi ? s.split(';') : s.split(',')).map(t => t.trim()).filter(Boolean);

  const targets = [];
  const rejected = [];

  for (const entry of parts) {
    const a = entry.indexOf(':');
    const b = a >= 0 ? entry.indexOf(':', a + 1) : -1;

    if (b < 0) {
      // No source:region: prefix. On a comma-separated list this is almost
      // always the tail of the previous school name — "University of
      // California, Los Angeles" arrives as a target plus a stray
      // " Los Angeles" — so put it back rather than discarding it. Guarding on
      // the comma alone cannot catch this: by the time the split has happened
      // the truncated half contains no comma and looks perfectly well formed,
      // which is why it shipped.
      if (!semi && targets.length) {
        targets[targets.length - 1].school += ', ' + entry;
        continue;
      }
      rejected.push(entry);
      continue;
    }

    const source = entry.slice(0, a).trim();
    const region = entry.slice(a + 1, b).trim();
    const school = entry.slice(b + 1).trim();
    if (!source || !region || !school) { rejected.push(entry); continue; }
    targets.push({ source, region, school });
  }

  return { targets, rejected };
}

module.exports = { parseCollectTargets };
