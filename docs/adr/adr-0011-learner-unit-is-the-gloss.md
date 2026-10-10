# ADR 0011: The learner's unit is the gloss

- **Status:** Accepted
- **Date:** 2026-10-10
- **Source:** [phase 31 design](../superpowers/specs/2026-10-09-lang-tutor-phase-31-glosses-design.md) — D1 and D2 for the unit and its key, D8 for a gloss per rendered sense, D17 for these rules

## Decision

A **gloss** is one target word of one lexeme in one learner language: a row of `dict_glosses`,
with a key (the target word in its citation form) and its alternatives. It is what a learner
saves, levels and is asked. A **sense** stays the dictionary's identity: `dict_senses` hangs off
a lexeme and carries no learner language, and the target word lives below it, per form and per
learner language, on `dict_var_translations`. Which gloss a sense belongs to is one row per
sense and learner language in `dict_sense_glosses`, so `mouse`'s two senses are one gloss for
Hebrew and would be two for Italian.

The learner's tables hold gloss ids rather than sense ids: a saved word (`vocabulary_entries`),
its progress (`gloss_progress`), the question a card was built from (`questions`), a session's
results (`session_progress`) and a photo import's items (`photo_import_items`). Every sense the
lookup renders has a gloss, written by the lookup and by the repair in the transaction of the
renderings it comes with, and before them, so a learner can save anything they are shown.

```
  dict_lexemes ◄── dict_senses ◄── dict_sense_glosses ──► dict_glosses ◄── vocabulary_entries
                        ▲          one row per sense                   ◄── questions
                        │          and learner language
              dict_var_translations
              the target word, per form and language

  An arrow points at the table a foreign key references. Everything up to and including
  dict_glosses is the dictionary; the tables that point at dict_glosses are the learner's,
  and none of them points at a sense.
```

## Rules

| # | Subject | Must | Must not |
|---|---|---|---|
| R1 | every table in `apps/server/src/db/schema.ts` whose name does not start with `dict_` | — | reference `dict_senses` or `dict_var_translations` |
| R2 | `vocabulary_entries` and `questions` | declare a foreign key to `dict_glosses` | — |

Tables whose name starts with `dict_` are the dictionary, and R1 does not apply to them:
`dict_var_translations` and `dict_sense_glosses` reference `dict_senses` by design.

## How to detect a violation

`npm run lint:arch` runs the two commands below alongside the other ADRs';
`scripts/check-adr-0011-learner-unit-is-the-gloss.sh` mirrors this block verbatim. Paste the
block at the repo root, then run `r1` and `r2`: each must print nothing.

```bash
SCHEMA=apps/server/src/db/schema.ts

# Every line of schema.ts, prefixed with the table whose pgTable(...) block it
# is in: the first quoted snake_case word after `pgTable(`, on its line or the next.
# The prefix is joined with \001, never a tab: a tab inside the source line would
# split it, and whatever followed the tab would leave field 2 unseen.
tables() {
  awk '
    /= pgTable\(/ { pending = 1; table = "" }
    pending && match($0, /'"'"'[a-z_]+'"'"'/) { table = substr($0, RSTART + 1, RLENGTH - 2); pending = 0 }
    { print table "\001" NR ": " $0 }
  ' "$SCHEMA"
}

# R1 — no table outside the dict_ prefix references dict_senses or dict_var_translations.
r1() {
  tables | awk -F '\001' -v file="$SCHEMA" '$1 != "" && $1 !~ /^dict_/ && $2 ~ /(dictSenses|dictVarTranslations)\./ { print file ":" $2 }'
}

# R2 — vocabulary_entries and questions each declare a foreign key to dict_glosses.
r2() {
  for t in vocabulary_entries questions; do
    tables | awk -F '\001' -v want="$t" -v file="$SCHEMA" \
      '$1 == want && $2 ~ /dictGlosses\./ { found = 1 } END { if (!found) print file ": " want " declares no foreign key to dict_glosses" }'
  done
}
```

### What the rules cover

- Scans `apps/server/src/db/schema.ts` only: its table definitions' foreign keys, whether
  written as `.references(...)` or `foreignKey(...)`. Tests are out, and so are migrations,
  which are history: `0010` still keys `vocabulary_entries` on a sense, and `0025` re-keys it.
- **The exception is the `dict_` prefix.** `dict_var_translations` and `dict_sense_glosses`
  reference `dict_senses`, and a new dictionary table may too. The prefix is matched, not a
  list, so none needs an edit here.
- R1 reads the Drizzle consts `dictSenses.` and `dictVarTranslations.`: a foreign key written
  as raw SQL, or through an aliased import, is outside what it sees. R2 passes when the
  table's definition mentions `dictGlosses.`; it does not parse the key. Neither skips
  comments, and a comment ahead of a table is read as part of the table above it.
- R2 names the two tables that hold a gloss as a foreign key. `gloss_progress` reaches it
  through its entry (`gloss_progress_entry_fk`). `session_progress` and `photo_import_items`
  hold gloss ids as snapshots and declare no key, so R2 does not ask for one.

## Why

- **R1 looks like tidiness and is a data rule.** The grouping is per learner language, so a
  learner row keyed on a sense would leak one language's grouping into every other (D1).
- **R2 is the explicit key.** What a learner saves, levels and is asked is a target word, so
  the table says so: its own row and id, not a sense standing in for the group. The key is also
  what stops a save or a card from naming an id that is no gloss (D2).

## Related

- [ADR 0001](adr-0001-layered-architecture.md) R4 — `db/schema.ts` is the persistence layer R4
  governs. R4 says what `db/` may import; this ADR says what its schema may reference. Phase 31
  amended R4 as well, for `db/cli.ts` and the gloss merge tool.
- [ADR 0008](adr-0008-access-grants.md) R1 — the same kind of rule, a table's references kept
  to named places, and the frame this script copies.
