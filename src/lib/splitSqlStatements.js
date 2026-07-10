'use strict';

// Split a multi-statement SQL string into individual statements on top-level
// semicolons, ignoring semicolons that live inside:
//   • single-quoted string literals  '…'   (with '' escape)
//   • dollar-quoted strings           $$…$$  or  $tag$…$tag$   (PL/pgSQL bodies)
//   • -- line comments
//
// This exists because src/db/migrate_missing.sql is applied statement-by-
// statement on boot (see server.js bootstrapSchemaAsync): running the whole
// file as one pool.query() means a single failing statement aborts every
// later one in the batch. But naively splitting on ';' breaks PL/pgSQL
// function bodies like:
//
//     CREATE OR REPLACE FUNCTION update_updated_at()
//     RETURNS TRIGGER AS $$
//       BEGIN NEW.updated_at = now(); RETURN NEW; END;
//     $$ LANGUAGE plpgsql;
//
// The semicolons inside $$…$$ are NOT statement terminators. The old splitter
// didn't know that, so this function was cut into fragments that each failed
// on every boot (the "3 failed statements" gotcha). Dollar-quote awareness
// fixes it: 0 failed statements on a healthy DB.
//
// Not a full SQL parser — it handles the constructs the bootstrap file uses.
// Notes:
//   • A dollar-quote OPEN tag is `$$` or `$ident$` (ident = letter/underscore
//     then word chars). `$1` placeholders and bare `$` are NOT tags (Postgres
//     rule), so they pass through untouched.
//   • Inside a dollar-quoted body EVERYTHING is literal until the exact
//     matching close tag — semicolons, quotes, and -- included.
function splitSqlStatements(src) {
  const out = [];
  let buf = '';
  let inSingleQuote = false;
  let dollarTag = null; // e.g. '$$' or '$func$' while inside a dollar-quoted body
  const OPEN_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/; // $$ or $ident$
  let i = 0;

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];

    // Inside a dollar-quoted body: consume verbatim until the matching close tag.
    if (dollarTag) {
      if (src.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      buf += c;
      i++;
      continue;
    }

    // -- line comment (only outside strings/dollar bodies)
    if (!inSingleQuote && c === '-' && n === '-') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end + 1;
      continue;
    }

    // Opening of a dollar-quoted string ($$ or $tag$) — only outside a '…' string.
    if (!inSingleQuote && c === '$') {
      const m = OPEN_TAG.exec(src.slice(i));
      if (m) {
        dollarTag = m[0];
        buf += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }

    if (c === "'") {
      // SQL '' is an escaped single quote inside a string
      if (inSingleQuote && n === "'") { buf += "''"; i += 2; continue; }
      inSingleQuote = !inSingleQuote;
      buf += c; i++; continue;
    }

    if (c === ';' && !inSingleQuote) {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = '';
      i++; continue;
    }

    buf += c; i++;
  }

  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

module.exports = { splitSqlStatements };
