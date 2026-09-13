# Phase 11 — Vocabulary backfill: what's left

- **Design doc:** `docs/superpowers/specs/2026-09-13-lang-tutor-phase-11-vocabulary-backfill-sourcing.md`
- **Branch:** `phase-11-vocabulary-backfill`
- **Done when:** every row in `words-all.csv` and `phrases-all.csv` has been attempted via
  `run-backfill-daily.mjs` (no separate quality gate — a backfilled row is accepted as-is).

## Checklist

- [ ] Words fully backfilled (`scripts/translation-backfills/en-he/words-all.csv`)
- [ ] Phrases fully backfilled (`scripts/translation-backfills/en-he/phrases-all.csv`)
- [ ] Open PR and merge `phase-11-vocabulary-backfill` into `master`

## How to continue

Gemini's 10K requests/day limit means this runs across multiple sessions. Each run stops
itself on a run of consecutive failures and writes a new `<category>-remaining-<timestamp>.csv`
with whatever didn't succeed.

Find the most recently dated remaining file for each category and run it:

```bash
cd scripts/translation-backfills/en-he
node run-backfill-daily.mjs --csv words-remaining-2026-09-13.csv
node run-backfill-daily.mjs --csv phrases-remaining-2026-09-13.csv
```

When a run finishes with "Nothing left to backfill from this file," check that box above.

Then back the day's work up to git, so a lost database never means paying for those
lookups again:

```bash
npm run vocab:export          # rewrites data/backfill/en-he/vocabulary.jsonl
git add data/backfill/en-he/vocabulary.jsonl && git commit -m "data: backfill through <date>"
```

To restore (a fresh machine, or production): `npm run vocab:restore`. It replays the
dataset through `persistEntries`, the same write path a live lookup uses, and is
first-writer-wins — so it is safe to re-run and never overwrites content already there.
