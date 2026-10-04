# Phase 18 — Enrollment vocabulary

- **Status:** Design approved section by section, 2026-10-04. Awaiting review of this written
  spec before planning.
- **Date:** 2026-10-04
- **Source:** the design dialogue recorded here, and a side research on what one entry is
  keyed on (`drafts/2026-10-03-vocabulary-entry-unit-decision.md`, with its prompt beside it).
  `drafts/` is gitignored, so the verdict this spec depends on is restated in §1.
- **Touches:** the translation wire contract (ADR 0003), ADR 0002 R6 (factory list), the
  phase 16 statement that the translation endpoint "never learns who asked".

## Goal

A learner saves meanings from a lookup into the active enrollment's word list, and browses that
list. Phase 10 left the per-sense button as decoration "until a later phase adds ownership";
this is that phase.

**Done means:**

1. A learner enrolled in `ru` looks up `прочитала`, taps **שמור** on one sense, and the sense is
   in their Russian list under `прочитать`.
2. **שמור הכל** saves every unsaved sense of a lookup in one tap.
3. A later lookup of `прочитаю` shows that meaning as already saved, and tapping it unsaves it.
4. The list shows one row per word, newest save first, paginated, with the top saved sense's
   translation and a `saved/total` mark. A row opens a drill-down listing every sense of the
   word, each with its own toggle.
5. Switching enrollment switches lists. A reverse lookup (`he → ru`) offers no save.
6. `npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e` and `npm run eval` pass.

## Scope

**In:**
- the `vocabulary_entries` table and an index on `dict_var_translations`;
- save, unsave, list (keyset-paginated) and drill-down routes;
- `sense_id`, `variant_id` and `saved` on translation senses, and an optional `enrollment_id`
  on the translation request;
- per-card שמור toggles and save-all on the translate screen;
- the list screen and the drill-down screen;
- a query-plan test at realistic volume.

**Out:**
- knowledge levels or any progress state;
- practice sessions drawn from the list;
- vocabulary-size statistics;
- form drills;
- search or filtering within the list;
- saving from a reverse lookup;
- the `vocabulary_words` rollup (§3 records it as the planned escalation);
- a new ADR or check script.

---

## 1. The unit of an entry

**One entry is keyed on (enrollment, sense).** It records the form it was first saved from, and
the form is not part of the key.

- Saving the same meaning again from another form (`прочитаю` after `прочитала`) adds nothing.
  The first form wins.
- The form is stored because a sense has no wording of its own. Translations and examples live
  on `dict_var_translations`, per form and sense. The lemma is not necessarily a stored form,
  so the saved form is the one rendering certain to exist.

The research verdict behind this, in brief:

- **Keying on the surface form inflates counts.** LingQ's Russian known-word count and
  Lingvist's learned-word count both count declined forms separately, and users report it.
- **Merging meanings fails learners.** One meaning per card is the established spaced-repetition
  advice, and LingQ's merged hints are a standing complaint.
- **Counting and learning call for different units** (Nation's VST specification; Webb 2021).
  The English Vocabulary Profile levels senses separately.
- **Word families are too coarse.** Stoeckel et al. 2020 found that lower-level learners who
  knew one part of speech knew the other only 56% of the time. Pealim keys Hebrew per binyan
  and uses the root only for navigation.

What the key means for later phases, none of which is built here:

- a knowledge level attaches per `(enrollment, sense)`;
- vocabulary size counts lexemes, a lexeme being known when any of its senses is;
- form drills derive from the lexeme and the saved form, never from entries of their own.

**Saves come from target-language lookups only.** In `ru → he` the senses belong to the Russian
lexeme. In `he → ru` they belong to the Hebrew lexeme, and `окно` is only a translation string
with no lexeme behind it. A reverse lookup therefore offers no save.

## 2. Data model

```
vocabulary_entries
  enrollment_id  text not null  → enrollments.id
  sense_id       text not null  → dict_senses.id    ON DELETE CASCADE
  lexeme_id      text not null  → dict_lexemes.id   ON DELETE CASCADE   -- copied from the sense
  variant_id     text not null  → dict_variants.id  ON DELETE CASCADE   -- the form first saved from
  created_at     timestamptz not null default now()

  PRIMARY KEY (enrollment_id, sense_id)
  INDEX vocabulary_entries_enrollment_lexeme_idx (enrollment_id, lexeme_id, created_at)
```

- **The index carries `created_at` as a third key column, not as `INCLUDE`.** drizzle-kit
  cannot express `INCLUDE`, and CI fails on any drift between `schema.ts` and the generated
  migrations. A trailing key column serves the same index-only scan.
- **The primary key is the research decision as a constraint.** A save is `ON CONFLICT DO
  NOTHING`, which is what makes the first form win.
- **No `user_id`.** `sessions` and `questions` carry one for their composite FK into
  `enrollments`. An entry reaches its learner through its enrollment, and nothing queries
  entries by user.
- **`lexeme_id` is a copy, and it cannot go stale.** A sense never changes lexeme, which is the
  same reasoning `dict_variants.language_code` gives. It keeps `dict_senses` out of every
  vocabulary read.
- **There is no FK to `dict_var_translations`, though `(variant, sense, language)` would be the
  tightest constraint.** `repairVariantRenderings` deletes and re-inserts a variant's
  renderings, so a statement-level FK would reject the delete. A deferred one would couple the
  vocabulary to the repair's internals. Instead:
  - the service checks at save time that the variant renders the sense in the enrollment's
    source language;
  - the repair's existing rule that it "may not drop a sense this variant already renders" keeps
    that true afterwards.
- **Checks made by the service, not the schema** (a failure is a 400):
  - the lexeme is in the enrollment's target language;
  - the variant belongs to that lexeme;
  - the rendering exists in the enrollment's source language.
- **No indexes on `sense_id`, `variant_id` or `lexeme_id` alone.** Postgres does not index the
  referencing side of an FK, so a cascade from one deleted dictionary row would scan this table.
  Nothing deletes dictionary rows one at a time today: the only path is `db:reseed`'s
  `TRUNCATE … CASCADE`, which does no lookups, and the dictionary has no TTL. A phase that adds a
  per-row delete adds the index it needs. The schema comment says so.
- **Cascades:**
  - `db:reseed` wipes saved entries along with the dictionary, as it already wipes sessions.
  - `dict:restore` into a live database is idempotent and deletes nothing, so entries survive
    it.

**`dict_var_translations` gains an index on `(sense_id, user_language_code)`.** Its primary key
leads with `variant_id`. The list's `sense_count` and the drill-down's representative rendering
both ask, per sense, which renderings exist in a language. Without this index that question scans
the dictionary's largest table.

### Migration

One drizzle migration creates `vocabulary_entries` and adds the `dict_var_translations` index.
Nothing is backfilled: no saved-word data exists. The index is built inside the migration
transaction, without `CONCURRENTLY`. Before merging, check the production row count of
`dict_var_translations`. If it has grown well beyond the ~90k-record backfill, move the index to
a separate non-transactional step.

## 3. API

New files: `routes/vocabulary.ts`, `services/vocabulary.ts` and `repo/vocabulary.ts`. Every
route uses `createRoute` (ADR 0003).

### Translation (changed)

`POST /translations` gains an optional `enrollment_id`. Each sense gains:

- `sense_id` and `variant_id`, both **optional**. A sentence is not stored, and a word whose
  write failed is still answered with 200. A sense without ids cannot be saved.
- `saved: boolean`, present only when all three hold:
  - `enrollment_id` is given;
  - `from` is that enrollment's target language;
  - the sense has ids.

Errors:

- an unknown `enrollment_id` → 404;
- a `{from, to}` that is not the enrollment's pair in either direction → 400.

`saved` comes from one query after the senses are assembled: `sense_id = ANY(…)` against the
primary key. The dictionary read, write, reconcile and repair paths are untouched.

This reverses phase 16's "the endpoint stays anonymous — it never learns who asked". The
comment on `TranslationRequestSchema` and the published route `description` are rewritten to
say the endpoint learns the enrollment when it is given one, and uses it for `saved` alone.
`openapi.test.ts` asserts the new wording.

### Save

`POST /enrollments/{id}/vocabulary`

```
{ entries: [{ sense_id, variant_id }] }      // 1–20 items
→ 200 { saved_sense_ids: string[] }
```

- One card and save-all are the same call.
- The whole request is one transaction. Every item is checked (§2) or nothing is written.
- A sense that is already saved is a no-op, and it is still listed in `saved_sense_ids`.
- Errors: an unknown enrollment → 404; any item failing a check → 400.

### Unsave

`DELETE /enrollments/{id}/vocabulary/senses/{sense_id}` → 204. It is idempotent: an entry that is not
there is also 204. Only an unknown enrollment gives 404.

### List

`GET /enrollments/{id}/vocabulary?limit=50&cursor=…`

```
{ items: [{ lexeme_id, lemma, part_of_speech,
            headline: { sense_id, translation, form },
            saved_count, sense_count }],
  next_cursor: string | null }
```

- **One row per lexeme**, ordered by the lexeme's newest save, descending, with `lexeme_id`
  descending breaking ties.
- **`headline`** is the saved sense with the lowest rank in its own saved form's rendering, with
  ties going to the earliest save. It is shown in that saved form's wording.
- **`sense_count`** counts the lexeme's senses that have some rendering in the enrollment's
  source language, so it matches what the drill-down can show.
- **Keyset pagination.**
  - The cursor is an opaque base64 encoding of the last row's `(last_saved_at, lexeme_id)`, and
    the next page is everything strictly after it.
  - Offset pages would skip or repeat rows whenever the learner saves or unsaves between pages,
    which is exactly what returning from a drill-down does.
  - `limit` defaults to 50 with a maximum of 100. A malformed cursor → 400.
- **Moving rows.** Saving another sense of an old word moves that word to the top. A learner
  deep in the list sees it on refresh, and it is never served twice, because keyset compares
  values and the moved row now sorts before the cursor. A word whose senses are all unsaved
  drops out.

**Query shape and cost.** A page groups one enrollment's entries by `lexeme_id`, computes
`max(created_at)`, applies the cursor in `HAVING` and takes `LIMIT`. The index's trailing `created_at` makes
the grouping an index-only scan of that enrollment's slice, with no access to the table itself
and no join. The headline and the counts are then fetched in batches for the page's lexeme ids.

So the cost grows with one enrollment's list, never with the table, and the list is bounded by
what one person saves by hand. A heavy learner reaches thousands of saved senses, and the plan
test (§6) budgets 20k.

**Planned escalation, not built.** If a real list ever breaks the budget, add a
`vocabulary_words (enrollment_id, lexeme_id, last_saved_at, saved_count)` rollup. It would be
written in the same transaction as the entries, and its index
`(enrollment_id, last_saved_at DESC, lexeme_id DESC)` would make a page O(page). It needs a
migration and a backfill but no wire change, because the cursor is already the rollup's key. It
is not built now because it adds a counter that every save and unsave must keep exact, and a
drift bug that cannot exist without it.

### Drill-down

`GET /enrollments/{id}/vocabulary/words/{lexeme_id}`

```
{ lemma, part_of_speech,
  senses: [{ sense_id, variant_id, form, translation, example?, saved }] }
```

- **Every sense of the lexeme that has a rendering in the source language.** Senses with no
  rendering are omitted.
- **Which rendering is shown:**
  - a saved sense is shown in its saved form;
  - an unsaved sense is shown in a representative rendering: the form spelled like the lemma
    if one exists, otherwise the form with the most renderings of this lexeme in the source
    language, with `variant_id` breaking ties.
- **Order:** saved senses first by rank, then the rest by rank.
- **Saving from here records the `variant_id` the sense was shown in.** "The form it was saved
  from" therefore stays true.
- **Status codes:**
  - 200 even when nothing is saved, so a learner who unsaves everything on this screen still
    sees it;
  - 404 for an unknown enrollment, an unknown lexeme, or a lexeme that is not in the enrollment's
    target language.
- **Not paginated.** It is bounded by one lexeme's senses.

### Cost of every query

| Query | Served by | Cost |
|---|---|---|
| `saved` on a lookup | PK, `sense_id = ANY(…)` | k point lookups |
| save / unsave | PK insert / delete | O(1) per item |
| list page | `(enrollment_id, lexeme_id, created_at)` index, index-only grouped scan | O(one enrollment's entries) |
| page enrichment | `(enrollment_id, lexeme_id)` index, `dict_var_translations (sense_id, user_language_code)` | O(page × senses) |
| drill-down | the same two indexes | O(one lexeme's senses) |

None of them grows with the table's total size.

## 4. Errors

| Case | Status | Error |
|---|---|---|
| unknown enrollment, on any vocabulary route or as a translation's `enrollment_id` | 404 | `EnrollmentNotFound` (existing) |
| translation pair is not the enrollment's | 400 | `PairNotEnrolled` (new) |
| a save item fails a §2 check | 400 | `InvalidVocabularyEntry` (new), naming the sense; the batch is rolled back |
| more than 20 items, empty `entries`, `limit` out of range | 400 | schema validation |
| malformed cursor | 400 | `InvalidCursor` (new): a schema cannot see inside the base64 |
| unknown lexeme, or wrong language, on the drill-down | 404 | `LexemeNotFound` (new) |
| unsave of an entry that is not saved | 204 | none |

The new classes go in `errors.ts` beside the existing ones and follow their shape.

## 5. Mobile

### Translate screen

Files: [translate.tsx](../../../apps/mobile/src/app/translate.tsx) and
[useTranslation.tsx](../../../apps/mobile/src/hooks/useTranslation.tsx).

- **Every lookup sends `enrollment_id: active.id`**, in both directions. The server decides
  where `saved` applies.
- **The exclusive "choose" is removed.** `chosenIndex` and `choose` are replaced by a per-sense
  saved state, seeded from the response's `saved` flags.
- **The toggle.** A card whose sense carries a `saved` flag gets a toggle: **שמור** when
  unsaved, and **נשמר ✓** when saved, which unsaves on tap. A reverse lookup carries no `saved`
  flag, so its cards have no toggle. That makes §1's rule structural, not a check in the screen.
- **Save-all.** **שמור הכל** sits above the cards and is shown when two or more senses are
  unsaved. It is one save call with every unsaved `{sense_id, variant_id}`.
- **Toggles are optimistic.** The state flips, the request is sent, and a failure reverts the
  state with a short notice. A toggle with a request in flight is disabled, so a double tap
  cannot race a save against an unsave.
- **`flip` takes the top-ranked sense**, the card wearing the badge. It used to take "the chosen
  sense, else the first".
- **"מלה חדשה" shows whenever results are shown.** It used to appear only after a choice.

| String | Change |
|---|---|
| `translateChoose` ("זו המשמעות שחיפשתי") | renamed `translateSave`, now `'שמור'` |
| `translateSaved` | new, `'נשמר ✓'` |
| `translateSaveAll` | new, `'שמור הכל'` |
| `translateSaveFailed` | new, the revert notice |
| `translateChosen` ("התרגום נשמר לאוצר המילים שלך") | deleted |

Deleting `translateChosen` closes the caveat phase 10 carried forward: the card's own saved state
now states the save, and truthfully.

### The list

New file: `apps/mobile/src/app/vocabulary/index.tsx`.

- **Entry point:** a home-screen button `אוצר המילים שלי`, next to the translate entry.
- **The header names the active enrollment's language**, so switching enrollment switches lists.
- **Rows** show the lemma, the part of speech and the headline translation, and add a
  `saved/total` mark when `sense_count > 1`.
- **Loading:** a `FlatList` that loads the next page on `onEndReached` and dedupes by
  `lexeme_id`. It reloads from the top on focus and on pull-to-refresh. Reloading on focus is
  what makes a drill-down's changes appear on return.
- **Empty state:** a line pointing to the translate screen.

### Drill-down

New file: `apps/mobile/src/app/vocabulary/[lexemeId].tsx`, a sibling of the list's `index.tsx`.

- The lemma and part of speech, then every sense as a card in the translate screen's style:
  - its translation and example;
  - the form it is rendered from, when that differs from the lemma;
  - the same שמור / נשמר toggle.
- **No save-all.** These senses are browsed, not just looked up, so bulk saving stays where the
  decision is fresh.

### State

- A `useVocabulary` hook owns the list's pages and exposes `save` and `unsave`, which both
  screens call.
- It is constructed at the composition root with the api client passed in, like
  `TranslationProvider` (ADR 0002).
- There is no cross-screen cache. Reloading on focus keeps the list honest, and the server
  stays the single source of truth.

## 6. Testing

### Unit

**Server (`apps/server/src`):**
- the cursor's encode/decode round trip, and its rejection of junk;
- headline selection: lowest rank, ties to the earliest save;
- the representative rendering: the lemma form, otherwise the form with the most renderings,
  ties by id;
- drill-down ordering.

**Mobile:**
- toggle state seeded from `saved`;
- the optimistic revert on failure;
- save-all visibility, which needs two or more unsaved;
- the list deduping across pages;
- `flip` taking the top-ranked sense.

### Integration (`apps/server/tests/integration/`)

**Constraints:**
- saving a sense twice in one enrollment is a no-op, and the first form is kept;
- the FKs reject an unknown sense, variant or enrollment.

**Routes:**
- every status in §4;
- save-all atomicity: one bad item writes nothing;
- unsave idempotency.

**Translation:**
- `saved` is present for a target-language lookup with `enrollment_id`;
- `saved` is absent for a reverse lookup, a sentence, and a request without `enrollment_id`;
- the 404 and the 400.

**Pagination:**
- walking a 120-word list in pages of 50 returns every lexeme exactly once;
- saving into an old word mid-walk neither duplicates nor loses anything on the pages not yet
  fetched;
- unsaving a word's last sense drops it from the list.

**Repair:** a repaired variant keeps its saved entries. This pins why §2 has no FK to
`dict_var_translations`.

**`vocabulary.plan.test.ts`:**
- **Setup:** `generate_series` bulk-loads about 200k entries across about 1k enrollments, plus
  one heavy enrollment with 20k entries, followed by `ANALYZE`.
- **Plans:** `EXPLAIN` each query in §3's cost table, and assert that no plan has a `Seq Scan`
  on `vocabulary_entries` or `dict_var_translations`.
- **Timing:** the list page for the heavy enrollment completes in under 50 ms.
- **Why it asserts absence:** an absent node type is the part of a plan that stays stable across
  Postgres versions.

**`openapi.test.ts`:** the new routes, and the rewritten translation description.

### Eval

Unchanged. Ids on the wire do not change what the model is asked.

### e2e

A new flow for a learner enrolled in `ru`:

1. They look up a word and save one sense.
2. They look up a second word and use **שמור הכל**.
3. They open the list: both words appear, and the first carries the `n/m` mark.
4. They open the first word's drill-down, save a second sense from there, and unsave one.
5. Back on the list, the counts agree.
6. A reverse lookup shows no **שמור**.

Gemini replies are registered under `E2E_MOCK_NAMESPACE` through the existing MockServer
helper.

### Architecture

`npm run lint:arch` passes:

- the new files sit in their layers (ADR 0001);
- `createVocabularyRepo` and `createVocabularyService` join the ADR 0002 R6 factory list;
- every route uses `createRoute` (ADR 0003);
- nothing hardcodes a port or database (ADR 0006).

No ADR or check script is added. The one new invariant, that the vocabulary is keyed on sense,
is a primary key, which is stronger than a grep.

## Build order

1. The schema, the migration and `repo/vocabulary.ts`, with the constraint tests.
2. The save, unsave, list and drill-down routes and the service, with the pagination and plan
   tests.
3. Translation: ids, `enrollment_id` and `saved`, plus the rewritten description.
4. The mobile translate screen.
5. The mobile list and drill-down.
6. The e2e flow.

## Risks

- **Sense over-splitting.**
  - **What goes wrong:** a near-duplicate sense in the dictionary becomes a near-duplicate entry
    in a learner's list.
  - **What exists already:** `reconcile` maps each new lookup onto the stored senses, which is
    the mitigation.
  - **What to watch:** the `dict_reconciled` log's `newly_named` count.
  - **The research fallback,** if this proves chronic: key on the lexeme with one primary sense.
- **The translation endpoint now reads learner data.**
  - **What goes wrong:** a dictionary answer is personalised on every response.
  - **The contract:** `enrollment_id` is used for `saved` alone. Any future use of it on the
    translation path is a new decision, not an extension of this one.
- **List cost grows with one learner's list.** It is bounded by hand-saving and measured by the
  plan test, and the rollup in §3 is the planned escalation.
- **Optimistic toggles can disagree with the server.** They revert on failure, and the list
  reloads on focus, so any disagreement lasts one screen at most.
