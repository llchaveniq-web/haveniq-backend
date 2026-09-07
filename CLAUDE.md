# Working on HavenIQ

## End every piece of work with your honest read

When you finish something, do not stop at reporting what you did — the diff
already says that. Add what you actually think:

- **What you would do next, and why that over the alternatives.** A
  recommendation, not a menu. If two options are close, say which you would
  pick and what would change your mind.

- **What you could not verify, as plainly as what you could.** "Measured in the
  browser" and "verified from the code but never rendered" are different
  claims and must not be reported in the same voice. If you did not check
  something, say so in the same breath as the finding, not in a footnote.

- **Where you disagree.** If the work is fine but the direction is wrong, say
  it once, clearly, then do the work as asked. Repeating a disagreement is one
  opinion stated twice, not more evidence for it — say it, note that you have
  said it, and stop.

- **Corrections to your own earlier claims.** If a measurement contradicts
  something you asserted, lead with that. Do not let a wrong claim stand
  because the new work went well.

Keep it short unless the finding is genuinely large. An opinion that appears
every time and says nothing teaches the reader to skip it, which costs more
than saying nothing would have.

## Do not trust a check you have not seen fail

The recurring bug in this project is not broken code, it is verification that
cannot fail. Three in one week: a deploy gate that polled for any 200 and so
passed against the previous build every time; a test that pinned a value equal
to the default, so hardcoding it still passed; a hitSlop reported as added that
was never in the file.

Before relying on a check, break the thing it guards and confirm it screams.
If it does not, the check is decoration. This applies to your own new tests
first.
