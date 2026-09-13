# Phase 11 — Sourcing words and phrases for bulk backfill

- **Status:** Sourcing scripts built and verified; bulk backfill started against both CSVs,
  hit the daily rate limit — continuing gradually
- **Date:** 2026-09-13
- **Source:** phase 10 (`docs/superpowers/specs/2026-09-10-lang-tutor-phase-10-vocabulary-persistence-design.md`)
  made every lookup a write to a shared, permanent dictionary. This phase asks: what should
  we write *before* anyone asks, so common lookups are already cache hits?

## Problem

Every translation that goes to the LLM (`services/translations.ts`, on a cache miss) takes
5–15 seconds. That's a bad user experience for a tutoring app — a learner tapping an
unfamiliar word mid-lesson shouldn't wait that long for a definition.

Reuse only helps once a string has already been looked up by someone. A backfill writes
rows before anyone asks, so the most common words and phrases are already cache hits from
day one — but only if we can source a real, filtered list of "most common" strings to feed
through the existing translation path.

Two lists are needed: single words and multi-word phrases (idioms, phrasal verbs,
fixed expressions). They don't share a source — word frequency and phrase curation are
different problems.

## Alternatives considered for the phrase list

- **Google Ngrams** (2–4 gram frequency data): no small fetchable mirror exists — the raw
  dataset is split into multi-gigabyte files with no ready "top N phrases" export. Would
  need bulk download + heavy filtering to reject grammatical fragments (`of the`, `in a`).
- **Kaikki / Wiktextract full dump**: 2.6GB compressed, 23GB uncompressed. Has the phrase
  data (phrasal verbs, idioms tagged directly), but needs streaming decompression and
  parsing for a one-time list, which is a lot of infrastructure for this.
- **Wiktionary category API** (chosen): querying `en.wiktionary.org`'s
  `list=categorymembers` for `Category:English idioms` / `English phrasal verbs` /
  `English proverbs` returns curated page titles directly — small (~17K total), no
  download, official. Anonymous API calls hit Wikimedia's shared rate limit (429s are
  transient, not a block) so the fetch needs retry-with-backoff.
  `Category:English multiword terms` was tried and rejected: 224,925 entries, mostly
  compounds/species names/place names, not curated phrases.

## Solution

Two generator scripts under `scripts/translation-backfills/en-he/`, each producing a
`text`-header CSV of the same shape:

| Script | Source | Output |
|---|---|---|
| `generate-words-csv.mjs` | SUBTLEX-US frequency data (words/subtlex-word-frequencies mirror) | `words-*.csv` — single words ranked by real-world frequency |
| `generate-phrases-csv.mjs` | Wiktionary category API (idioms, phrasal verbs, proverbs) | `phrases-*.csv` — curated multi-word expressions, no frequency rank |

Both scripts apply the same shape of filtering before writing: drop entries already in
`content.generated.ts`'s seed set, drop case-insensitive duplicates, drop fragments/noise
specific to their source (contraction fragments for SUBTLEX; disambiguation-style titles
and >6-word/>100-char entries for Wiktionary phrases).

**Execution path:** `run-backfill.mjs` POSTs each row to a running server's
`/api/translations`. A cache miss there runs the same live-model-then-write path as any real
lookup (`services/translations.ts` → `persistEntries`), so running this script against a CSV
*is* the backfill — there is no separate ingestion step. It was built for cost estimation
but doubles as the actual write mechanism. A run against both CSVs was started and hit
Gemini's daily rate limit partway through (see below) — the backfill is real but partial,
to be continued gradually.

## Cost and rate limit

Measured against real Gemini calls: **1,100 words cost ~7 ILS.** Scaled to the full
74K-word + 14.5K-phrase set (~89K entries), that's roughly 570 ILS total — a one-time cost,
not a recurring one, since a backfilled row is never re-asked.

Gemini's rate limit is **10K requests/day**, hit in practice when a full run was attempted
in one go. At that ceiling, the full backfill takes **~9 days run gradually** (89K
requests ÷ 10K/day) rather than one sitting — acceptable, since this is a one-time
offline job with no user-facing deadline.

## Open questions / not yet done

- The backfill is in progress, not complete: a run against both CSVs hit the 10K RPD limit
  partway through, so most of the ~89K entries are still unwritten.
- The gradual, multi-day run needs a resumable driver (skip rows already persisted, respect
  the daily quota, pick up where the previous day left off) — `run-backfill.mjs` as it
  stands is a single unbounded batch, not built for that yet.
