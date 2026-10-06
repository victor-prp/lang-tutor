# Phase 21 — Saved list by lemma

- **Status:** Implemented on branch `phase-21-saved-list-by-lemma`, with the deviations from the
  approved design folded in. The design was approved on 2026-10-06: Victor approved the brief,
  the grouping key and the kept save toggle in the dialogue, then delegated the remaining
  decisions; those are recorded in §1 with their reasons.
- **Date:** 2026-10-06
- **Source:** the one-pager `drafts/2026-10-06-saved-list-by-lemma-one-pager.md` and the design
  dialogue recorded here. `drafts/` is gitignored, so everything this spec depends on is
  restated below.
- **Builds on:** phase 20, progress per sense (PR #81). Reverses phase 18's one list row per
  lexeme. Keeps the entry-unit decision of 2026-10-03: a saved entry is keyed on
  (enrollment, sense), and nothing here changes that key.
- **Touches:** ADR 0003 (the vocabulary wire contract). No new ADR and no new check script.

## Goal

A learner who saves a word sees it once in the saved list, however many parts of speech it
has. Today "main" and "bloody" each appear twice, once per lexeme, and the two rows read as
duplicates. The list should show a word the way the learner thinks of it.

**Done means:**

1. A lemma appears once in the saved list, whatever parts of speech its saved senses have.
2. Opening a word shows the senses of every part of speech of that lemma together, as cards,
   each labelled with its part of speech, saved senses first. The cards are not grouped into
   sections.
3. Each card keeps today's save toggle, so a sense can be saved or unsaved from the detail.
4. The list has no sort chips. The level filter offers "all", selected by default.
5. A merged word has one level, and the level filter treats it as one word.
6. `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass. `npm run eval`
   is untouched: this phase adds no prompt.

## Scope

**In:**
- a `lemma` column on `vocabulary_entries`, its migration and backfill, and an index for it;
- one list row per lemma, with its level, its saved parts of speech and a saved/total mark
  counted across the lemma's lexemes;
- the word detail addressed by lemma, showing every sense of every lexeme of that lemma;
- a part-of-speech label on every detail card;
- removing the `sort` query parameter and the two level orders, server and app;
- an "all" chip on the level filter, selected by default.

**Out:**
- any change to how a sense is saved or unsaved, or to the translate screen;
- the home screen's saved count, which keeps counting senses;
- a trash icon or delete confirmation on the detail (the one-pager asked for one; the dialogue
  dropped it, §1);
- any redesign of the detail's save toggle. Victor named it as unintuitive, to be fixed in a
  later phase;
- vocalised or root-based grouping for Hebrew.

---

## 1. Decisions

From the dialogue with Victor:

- **The grouping key is the lemma string within the enrollment's target language.** Two
  lexemes with the same lemma are one word, even when unrelated: unvocalised Hebrew ספר the
  book and ספר the verb merge. The learner typed the same string both times, and the
  part-of-speech labels on the cards keep the senses apart. The match is exact and
  case-sensitive, as the dictionary stores lemmas: English "May" and "may" stay two words.
- **The detail keeps unsaved senses and the save toggle.** The one-pager's trash icon and
  confirmation are dropped. The toggle's UX is a known problem, deferred.
- **The row keeps its saved/total mark**, now counted across every lexeme of the lemma, because
  the detail still shows every sense the mark counts.

Decided here, under Victor's delegation:

- **The lemma is copied onto each entry (§2), not joined from the dictionary at read time.** A
  measurement settled it. On the plan test's volume (one enrollment of 20k entries, 1,000
  enrollments of 200) with a dictionary of 300k lexemes, the heavy enrollment's first list page
  took:

  | List query shape | Execution time |
  |---|---|
  | Phase 20, grouped by lexeme | 15.6 ms |
  | Joined to `dict_lexemes`, grouped by lemma | 98.6 ms |
  | Lemma copied onto the entry, grouped by it | 13.4 ms |

  The join costs one primary-key lookup per entry and doubles the budget of 50 ms. The copy
  costs a column, kept correct by a foreign key (§2), and nothing at read time.
- **The server drops the level sorts and the `sort` parameter.** The app is the only client and
  no longer offers them. Keeping them would keep two cursor shapes and their plan-test cases
  alive for nothing.
- **The list's one order is newest save first**, the lemma breaking ties.
- **The detail's card order is saved first, then part of speech, then rank, then sense id.**
  Senses of one part of speech sit together without a section header.
- **The detail is addressed by a query parameter**, `?lemma=`, not a path segment. A lemma may
  hold a space or a slash, and a query parameter carries both without depending on how the
  router treats an encoded slash.
- **The row names the parts of speech its saved senses have**, so a merged row says it is
  merged: "שם עצם · פועל" for a noun and a verb. The order follows the part-of-speech codes,
  alphabetically, so it is stable across reloads.

## 2. Data model

### `vocabulary_entries.lemma`

```
vocabulary_entries
  enrollment_id  text not null
  sense_id       text not null
  lexeme_id      text not null
  lemma          text not null            -- new: the lexeme's lemma, copied at save time
  variant_id     text not null
  created_at     timestamptz not null default now()

  PRIMARY KEY (enrollment_id, sense_id)
  FOREIGN KEY (lexeme_id, lemma) → dict_lexemes (id, lemma)
                                   ON DELETE CASCADE ON UPDATE CASCADE   -- replaces the lexeme FK
```

- **The copy cannot drift.** The single-column foreign key `vocabulary_entries_lexeme_fk` is
  replaced by a composite one, `vocabulary_entries_lexeme_lemma_fk`, on `(lexeme_id, lemma)`
  against a new unique constraint `dict_lexemes_id_lemma_key (id, lemma)`. An entry whose lemma
  differs from its lexeme's is rejected by Postgres, and if a lemma were ever rewritten the
  change would cascade. Nothing rewrites a lemma today. Deleting a lexeme still cascades its
  entries away, as before.
- **The lemma alone identifies the word within an enrollment.** Every entry's lexeme is in the
  enrollment's target language (`saveable` enforces it), so no language column is needed on
  the entry.
- **Save writes it.** `saveable` already joins the lexeme; it returns `l.lemma` too, and
  `insertEntries` inserts it.

### Index

`vocabulary_entries_enrollment_lexeme_idx (enrollment_id, lexeme_id, created_at)` is dropped:
its two readers, the summaries' saved count and the detail's saved entries, now read by lemma.
It is replaced by `vocabulary_entries_enrollment_lemma_idx (enrollment_id, lemma, created_at)`.

### Migration `0013_vocabulary_entries_lemma.sql`

Generated with `npm run db:generate --workspace apps/server`, then edited by hand, because
drizzle-kit adds a NOT NULL column in one statement, which fails on existing rows:

1. drop `vocabulary_entries_lexeme_fk` and `vocabulary_entries_enrollment_lexeme_idx`;
2. add `lemma` as nullable;
3. backfill it from `dict_lexemes` through `lexeme_id`;
4. set it NOT NULL;
5. add `dict_lexemes_id_lemma_key`, the composite FK `vocabulary_entries_lexeme_lemma_fk` and
   `vocabulary_entries_enrollment_lemma_idx`.

A header comment says what it does. `npm run db:check --workspace apps/server` must pass after
the edit, so the snapshot still matches the schema.

## 3. API

### List — `GET /enrollments/{id}/vocabulary` (changed)

**Query:** `limit`, `cursor`, `level`. `sort` is removed from `VocabularyPageQuerySchema`, and
`VocabularySortSchema` and the `VocabularySort` type leave `packages/core`. An unknown query
parameter is ignored, as on every route.

**Item, `VocabularyWord`:**

```ts
{
  lemma: string;
  parts_of_speech: string[];   // distinct, of the saved senses, alphabetical by code
  headline: { sense_id: string; translation: string; form: string };
  saved_count: number;         // saved senses across the lemma's lexemes
  sense_count: number;         // senses with a rendering in the source language, same lexemes
  level: Level;                // rounded mean over every saved sense and live dimension
}
```

`lexeme_id` and `part_of_speech` leave the item.

**Page query,** in `vocabularyQueries.wordsPage`:

```sql
SELECT ve.lemma, max(ve.created_at)::text AS last_saved_at,
       floor(avg(p.level) + 0.5)::int AS level
FROM vocabulary_entries ve
JOIN sense_progress p ON p.enrollment_id = ve.enrollment_id
                     AND p.sense_id = ve.sense_id
                     AND p.dimension IN (<live>)
WHERE ve.enrollment_id = $1
GROUP BY ve.lemma
HAVING <the level filter and the cursor condition, whichever apply>
ORDER BY max(ve.created_at) DESC, ve.lemma DESC
LIMIT $n
```

The level filter is `level = $level`. The cursor condition is
`(max(ve.created_at), ve.lemma) < ($saved_at::timestamptz, $lemma::text)`. With neither, there
is no HAVING.

The level is phase 20's arithmetic over a wider group: every saved sense of every lexeme of
the lemma. A word saved into again moves to the top, behind any cursor, so it is never served
twice in one walk, as phase 18 established.

**Summaries query,** `vocabularyQueries.wordSummaries`, takes the page's lemmas, the
enrollment, the target language and the source language, and returns per lemma:

- the headline: the saved sense with the lowest rank in its saved form, then the earliest
  save, then the lowest sense id, across every saved entry of the lemma (phase 18's rule,
  widened);
- `parts_of_speech`: `array_agg(DISTINCT l.part_of_speech ORDER BY l.part_of_speech)` over the
  lemma's saved entries joined to their lexemes;
- `saved_count`: the lemma's saved entries;
- `sense_count`: senses of every lexeme with that lemma in the target language that have a
  rendering in the source language.

A lemma with no rendered saved sense has no headline and is dropped from the page, as phase 18
does for a lexeme. The cursor is still taken from the page rows.

**Cursor.** `VocabularyCursor` becomes `{ savedAt: string; lemma: string }`, encoded as
base64url JSON of `['lemma', savedAt, lemma]`. The leading tag makes a phase 18 or phase 20
cursor, two or four elements, decode to `null` and answer 400, rather than be read as a
position in another order. Decoding keeps the timestamp checks and requires a non-empty lemma
with no NUL. Cursors live only in the app's memory, so the only cursor this refuses is one held
across a deploy, and the list reloads on focus.

### Detail — `GET /enrollments/{id}/vocabulary/word?lemma=` (replaces `/words/{lexeme_id}`)

**Query:** `lemma`, a non-empty string, declared as `VocabularyWordQuerySchema` in
`packages/core`. Missing or empty is a 400 `invalid request`.

**Body, `VocabularyWordDetail`:**

```ts
{
  lemma: string;
  level: Level | null;         // over every saved sense of the lemma; null when none is saved
  senses: VocabularySense[];   // each gains part_of_speech
}
```

`lexeme_id` and the word-level `part_of_speech` leave the body. `VocabularySense` gains
`part_of_speech: string` and is otherwise unchanged: `sense_id`, `variant_id`, `form`,
`translation`, optional `example`, `saved`, optional `progress`.

**Service,** `wordDetail(enrollmentId, lemma)`, in one transaction:

1. the enrollment, or 404;
2. every lexeme with `language_code = target_language AND lemma = $lemma`, served by the
   existing unique index on `(language_code, lemma, part_of_speech)`. None is a 404
   `word not found`; the error class `LexemeNotFound` is renamed `WordNotFound`;
3. the renderings of those lexemes' senses in the source language, each carrying its lexeme
   id;
4. the enrollment's saved entries with that lemma, through the new index;
5. their progress rows, as today.

`buildWordDetail` takes the lemma and the word's lexemes (id and part of speech) instead of one
lexeme. It chooses each unsaved sense's representative form within that sense's own lexeme, by
phase 18's rule: the lemma's own spelling, otherwise the form rendering the most senses of that
lexeme, ties by variant id. A saved sense is shown in its saved form. Cards are ordered saved
first, then `part_of_speech` ascending, then rank, then sense id. The level is `badge` over the
live rows of every saved sense, as today.

A lemma that is in the dictionary with nothing saved still answers 200 with `level: null`,
which is what the detail shows after its last sense is unsaved.

### Unchanged

Save, unsave, the `saved` flags on translate lookups, the home screen's `saved_count`,
`sense_progress`, `session_progress` and the session routes.

## 4. Mobile

### Saved list, `apps/mobile/src/app/vocabulary/index.tsx`

- **The sort chips are removed**, with `strings.sortNewest`, `sortLevelAsc` and `sortLevelDesc`.
- **The level filter gains a first chip, "הכל"** (`strings.levelAll`, testID
  `vocabulary-level-all`), selected while no level is chosen. The chips behave as one choice:
  tapping a level selects it, tapping "הכל" clears it, tapping the selected chip changes
  nothing. `nextLevelFilter`, which cleared a level on a second tap, is removed with its test.
- **A row is keyed by its lemma.** It shows the lemma, the mark when `sense_count > 1`, the
  badge, the parts of speech and the headline translation. The parts of speech line is
  `partsOfSpeechLabel(item.parts_of_speech)`, a new pure helper in `apps/mobile/src/vocabulary.ts`
  that maps each code through `strings.partOfSpeech`, drops the ones with no name, and joins the
  rest with " · ".
- **Tapping a row** pushes `{ pathname: '/vocabulary/word', params: { lemma } }`.
- `appendPage` de-duplicates by lemma instead of lexeme id.

### Word detail, `apps/mobile/src/app/vocabulary/word.tsx`

Renamed from `[lexemeId].tsx`, a static route reading `lemma` from its search params.

- The header shows the lemma and the word's badge. The word-level part of speech is gone.
- **Each card shows its part of speech** (testID `vocabulary-sense-pos`) above its translation,
  named through `strings.partOfSpeech`; a code with no name shows nothing.
- The save toggle, its optimistic flow, the re-read after a toggle and `keepSenseOrder` are
  unchanged, with `lemma` where `lexemeId` was.

### State and client

- `VocabularyQuery` becomes `{ level: number | null }`, defaulting to `{ level: null }`.
- `loadWord(lemma)`.
- `api.listVocabulary` loses `sort`. `api.vocabularyWord(enrollmentId, lemma)` gets
  `/api/enrollments/{id}/vocabulary/word?lemma=<encoded>`, encoding the lemma with
  `encodeURIComponent`.

## 5. Errors

| Case | Status | Error |
|---|---|---|
| bad `level` or `limit` on the list | 400 | `{ error: 'invalid request' }` (existing) |
| cursor malformed, or issued before this phase | 400 | `InvalidCursor` → `invalid request` (existing) |
| detail without `lemma`, or with an empty one | 400 | `{ error: 'invalid request' }` |
| unknown enrollment | 404 | `enrollment not found` (existing) |
| no lexeme with this lemma in the target language | 404 | `WordNotFound` → `word not found` |

## 6. Testing

### Unit, server

- `encodeCursor`/`decodeCursor`: the round trip, including a lemma with a space or a slash; a
  two- or four-element array (a phase 18 or phase 20 cursor), a wrong tag, an empty lemma and a
  lemma with a NUL each decode to `null`; the timestamp checks still apply.
- `cursorAfter` takes the last page row.
- `assemblePage` keeps page order, keys by lemma, carries `parts_of_speech`, and drops a lemma
  with no summary.
- `buildWordDetail` with two lexemes of one lemma: every sense of both appears; each carries its
  part of speech; saved first, then part of speech, then rank, then sense id; a saved sense
  keeps its own lexeme's part of speech; the level spans both lexemes' saved senses. The
  single-lexeme cases still cover the representative form, the fallback when a saved form no
  longer renders its sense, and the null level when nothing is saved.

### Unit, mobile

- `partsOfSpeechLabel`: one code, two codes joined, an unknown code dropped, an empty list.
- `appendPage` de-duplicates by lemma.
- the client: `listVocabulary` sends a level and no `sort`; `vocabularyWord` puts the lemma in
  `?lemma=`, encoded, with a space, a Cyrillic lemma and a slash as cases.
- `strings.levelAll` is "הכל".

### Integration, real Postgres

- **Schema:** the column is NOT NULL; the indexes on `vocabulary_entries` are exactly the
  primary key and `vocabulary_entries_enrollment_lemma_idx`; an entry whose lemma differs from
  its lexeme's is rejected by the foreign key, even when another lexeme has that lemma.
- **Migration:** entries saved before it get their lexeme's lemma.
- **Repo:** save writes the lemma; the page groups two lexemes of one lemma into one row, at
  its newer save, with one level; the level filter sees the merged level; the page orders by
  newest save, breaks a tie by lemma descending, keeps microseconds and continues strictly
  after a cursor, also under a level filter; lemmas that differ only in case stay two rows;
  summaries count saved and total senses across lexemes and list the parts of speech, naming
  only those with a saved sense; the detail's reads find both lexemes and their saved entries.
- **Routes:** a walk of 120 lemmas in pages of 50 serves each once, newest first, also when an
  old lemma moves to the top, or gains a save in another of its lexemes, mid-walk; a lemma with
  two lexemes is one row with both parts of speech, counts across both and has one level, and
  keeps its row when one lexeme's last saved sense is unsaved; the list ignores a `sort` an
  older app still sends, and a phase 18 or phase 20 cursor answers 400; the detail by lemma
  merges two lexemes, matches the lemma exactly, answers 404 for a lemma not in the target
  language, 400 for a missing or empty lemma, and finds a lemma with a space or a slash.
- **Plan test:** the fixture writes `lemma`. The list's shapes are now three: first page, after
  a cursor, one level. Each still reads progress through
  `sense_progress_enrollment_dimension_idx` and scans no watched table sequentially. The heavy
  enrollment's first page and its first one-level page each stay under 50 ms. The detail's
  lemma reads (lexemes by lemma, renderings of those lexemes, saved entries by lemma) are added,
  and `dict_lexemes` joins the watched tables. The saved-entries read must go through
  `vocabulary_entries_enrollment_lemma_idx`, which the sequential-scan check alone cannot tell
  from a bitmap scan of the primary key.
- Every fixture that inserts into `vocabulary_entries` directly supplies `lemma`.

### E2E

1. **`vocabulary.spec.ts`, new test:** a Russian learner looks up знать, whose lookup returns
   two lexemes, the verb (to know) and the noun (nobility), saves both senses with save-all, and
   sees one row for знать with the mark 2/2 and both parts of speech. The detail shows both
   cards, the noun first, each labelled with its part of speech; unsaving the noun sense keeps
   the row, with the mark 1/2 and only the verb named. The lookup comes from a `ZNAT` fixture in
   `e2e/tests/support/lexemes.ts`.
2. **`vocabulary.spec.ts`, existing test:** unchanged in behaviour; it navigates through the
   lemma route.
3. **`progress.spec.ts`:** the sort steps are replaced by a check that no sort chip exists and
   that "הכל" is visible when the list opens. The filter step selects a level, then taps "הכל"
   to clear it; the empty-level step clears the same way.

### Eval

None. No prompt is added.

## 7. Risks and what to watch

- **Unrelated homographs merge.** Once Hebrew is a target language, ספר the book and ספר the
  verb share a row and a level. Accepted in the dialogue; the cards' part-of-speech labels keep
  them apart, and a vocalised key would need dictionary data that does not exist yet.
- **A merged level hides a weak sense.** A word whose adjective is at level 5 and whose noun
  was just saved shows level 3. This is phase 20's averaging across senses, now across parts of
  speech too; the detail shows each sense's level.
- **The copied lemma.** Its correctness rests on the composite foreign key, which the schema
  test pins.
