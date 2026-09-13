# Phase 10 — Persisting and reusing vocabulary

- **Status:** Approved, ready for an implementation plan
- **Date:** 2026-09-09
- **Source:** phase 9 left `vocab_terms`, `term_variants`, `vocab_term_senses` and
  `term_sense_translations` untouched by design; this phase connects them

## Summary

A translation that the model answers is written to the shared dictionary, and the next
lookup of that string — by anyone — is served from Postgres without reaching the provider.
Phase 9 asked the model every single time, including for words it had already answered.

The model is asked for **entries**, not for one word. A learner typing `saw` gets the verb
`see` and the noun `saw` in one answer, because the string genuinely means both, and both
are written.

**The seed is a recording, not a special case.** `content.ts` holds a real provider answer
per seeded string, generated once against Gemini and reviewed by hand, and `seed.ts` replays
it through the same write path a lookup uses. Seeded rows and looked-up rows are
indistinguishable because they were made the same way — which is why nothing in this design
has to ask which kind a row is.

Nothing about the wire changes. `POST /api/translations` keeps its request, its response,
its three statuses and its published OpenAPI document, and `apps/mobile` is not touched at
all.

## What this adds

| Area | Addition |
|---|---|
| DB | Migration `0003` — part of speech moves to the sense; senses gain `rank` and `example_source`; translations gain `example_target`; variants gain `language_code` and `entry_rank`; three tables gain an id default; one unique index that doubles as the lookup index. It also clears the seeded content and quiz tables so the new fixture takes |
| Content | `content.ts` keeps the quiz authoring; `content.generated.ts` holds the recorded answers |
| Tooling | `tests/eval/generate-content.ts` and `npm run content:generate [-- <query>]` — the recorder; `npm run db:reseed` — clear and replay it |
| Server | `domain/vocabulary.ts` — normalization and row/entry mapping. Pure |
| Server | `repo/vocabulary.ts` — the lookup and the write, used by the service and by the seed |
| Server | `services/translations.ts` — read, then the model on a miss, then write |
| Core | `LlmTranslationSchema` becomes `{ kind, entries[] }`, each entry a lemma with its own ranked senses. The wire response is unchanged |
| Docs | ADR 0001 R8 amended, and R4's import list gains `repo/*` for `db/`; ADR 0002 R6's factory list gains `createVocabRepo`; ADR 0004 R4's eval-bucket clause covers the recorder |

No new table. No new endpoint. No change to `apps/mobile`. One behaviour change from phase 9:
an inflected form returns its headword's entry, alongside any other headword the string
belongs to.

## Decisions settled during design

**The dictionary is shared and records no learner.** There is no `user_id` anywhere near the
vocabulary tables and none is added. A save enriches the global dictionary; the second
learner to ask a word benefits from the first. The consequence is deliberate and has a cost:
"my words" cannot be built on this data, and a later phase that wants it adds a join table
rather than finding one waiting.

**The write happens on every translation, not on the confirm tap.** A miss persists the whole
answer — every entry, every sense, ranked, with its part of speech, example and translation
— so the *next* lookup is complete rather than holding only the one sense somebody happened
to pick. Writing on the tap instead would have left `bank` cached with a single sense and no
**more** control, which is the feature phase 9 was built around, and would have cached
nothing at all for the lookups a learner abandons after reading.

The visible consequence: **the per-sense button is now decoration.** The rows were written
when the answer arrived, so choosing a sense confirms something that already happened and
records nothing. The button stays — marking which meaning you meant is a real interaction,
and a later phase that adds ownership has somewhere to attach it — but nobody should read the
code expecting that tap to write.

**`התרגום נשמר לאוצר המילים שלך` keeps its wording.** Phase 9 filed this string as a
deliberate untruth to be fixed here. It is now half true: the translation is genuinely saved,
but not to anything of the learner's. Keeping `שלך` was chosen over dropping it because it
reads as the app's vocabulary from the learner's point of view, and it becomes literally
correct on the day ownership arrives. The risk phase 9 recorded is carried forward rather
than closed, and a play-test should still be read that way.

**Part of speech describes a meaning, not a word.** `book` is a noun (`ספר`) and a verb
(`להזמין`) — phase 9's own route test uses exactly that example — so `part_of_speech` moves
from `vocab_terms` to `vocab_term_senses`. The column was written by `db/seed.ts` and read by
nothing, so moving it costs a backfill and no consumer. A term therefore carries senses
spanning parts of speech, and entries split by *lemma*, not by part of speech.

**The model returns entries, because a string can be more than one word.**

```ts
LlmTranslationSchema = {
  kind: 'word' | 'phrase' | 'sentence',
  entries: [                       // ranked: the likeliest reading of the typed form first
    { lemma: string,
      senses: [{ translation, part_of_speech?, example?, sense_code }] }   // ranked within
  ]
}
```

An earlier draft asked for a single `lemma`, and under it a learner typing `saw` was told the
string means `לראות` and never `מסור` — the tool reading appeared only if somebody later
happened to type `saws`. Capped in the prompt at three entries and five senses each; most
strings have one entry, so the typical answer is the size phase 9 already returns.

**One entry per lemma, enforced in `domain/` rather than trusted.** Dictionaries publish
`book` as two entries — Merriam-Webster gives `book:1` and `book:2` — so a model may well
split by part of speech. Under `UNIQUE(language_code, lemma)` the second such entry would
resolve to the same term, find senses already written, and be silently dropped. The prompt
therefore says senses spanning parts of speech go in **one** entry, and `mergeEntries` in
`domain/vocabulary.ts` concatenates same-lemma entries before the write regardless. Rejecting
the answer instead would throw away content over a formatting choice.

**Senses belong to the lemma named by their entry**, not to the string that was typed — so
`saw`'s first entry carries `see`'s senses. Storing a typed form's senses under a different
headword is how `t-leave` would end up holding `שמאל`, which is not a sense of `leave` in any
reading. Every lexical source models it the same way: `LexicalEntry → Lemma + Forms →
Senses`. See *Prior art*. Typing `running` therefore returns `run`'s entry with an example
built on `run`, which is a deliberate change to what phase 9 shipped.

**A variant is written only for the form that was actually queried.** No lemma alias is
synthesized. An earlier draft wrote one, to make `run` free after `running`, and it created a
defect in mirror image: asking `saws` would have synthesized a `saw` variant on the noun, and
a later `saw` would **hit** it and return `מסור` alone, never asking the model whether the
bare string has other readings. An alias is a guess about a string nobody looked up.

The cost is explicit: **`running` then `run` is two provider calls, not one.** The lemma still
earns its place — senses on the right headword, `recieve` absorbed into `receive`, several
readings merged into one answer — but not by avoiding a call. What survives is the goal the
phase set out to meet: the same string asked twice is free.

**A form may belong to several terms, and merging them is the answer.** `UNIQUE(term_id,
form)` scopes variant uniqueness per term, so `saw` is a variant of `see` *and* of `saw`. An
earlier draft treated that as the defect and proposed a `form_index` table forcing one term
per form; that would have returned `מסור` alone and `ראה` never — strictly less than a
learner wants, and the opposite of what every source in *Prior art* does.

**The real defect was the tie, and the model breaks it.** `ORDER BY s.rank` cannot order two
terms, because `UNIQUE(term_id, rank)` only orders within one. `term_variants` gains
**`entry_rank`**: this term's position among the entries the model returned *for this form*.
It sits on the variant rather than the term because it is a property of the pairing — `saw`
ranks `see` first, while `saws` returns `saw` alone at 0.

```sql
ORDER BY s.rank,        -- round-robin across headwords
         v.entry_rank,  -- the model's own ranking, made with every reading in one context
         v.term_id      -- total; the first two cannot both tie across terms in practice
```

That is a calibrated comparison nothing else could supply. Scoring senses for "commonness" at
write time would not work: `see`'s senses and `saw`'s are scored in different calls with no
shared context, so the numbers would never have met. Ranking entries inside one call is a
comparative judgment, which is the kind models are reliable at.

**Rank leads, so the merge is round-robin rather than block-per-entry.** Ordering by entry
first would put all of `see`'s senses ahead of `saw`'s, and a five-sense `see` would push
`מסור` off the five cap — the same disappearance the rejected `form_index` caused, by another
route. Interleaving by rank guarantees every headword's most common sense reaches the answer.

**`entry_rank` is `NOT NULL` and its uniqueness is enforced**, by a unique index on
`(language_code, lower(form), entry_rank)`. This is safe only because the seed goes through
the standard path: a seeded form is servable, so it always hits and is never written a second
time, and within one write the ranks are distinct by construction. Two earlier drafts spent
considerable effort on nullable ranks, promotion guards and conflict updates, all to protect
against a seeded row holding a rank no model gave it. Recording the seed removes the
condition instead of defending against it.

**Every sense is stored; only the response is capped.** The database has no five limit, so
`see` keeps all its senses and `saw` all of its. `TranslationResponseSchema`'s `max(5)`
truncates the flattened answer and nothing else, which is why a later lookup of `see` returns
its full entry rather than whatever slice fitted alongside `saw`.

**First writer wins on senses, permanently.** A term that already has senses is never
rewritten, merged or refreshed. There is no TTL and no invalidation. This makes the
concurrent case trivial; it is also why a poor answer for a new headword is served to
everyone from then on. See *Risks*.

**A form's answer is fixed once written.** A variant exists only for a string somebody
queried, and a queried string thereafter hits — so nothing can add a term to a form that
already has one. The guarantee is absolute rather than monotone: **the same string returns
the same senses in the same order, forever.** The price is the same coin's other face: if the
model missed a reading on the one call that mattered, no later lookup will discover it.

**A sentence, an empty entry list and a failure are never written.** Repeat lookups of each
keep costing. A sentence is not a vocabulary item — phase 9 decided that — and caching "no
translation" or "the provider was down" would freeze a transient answer into a permanent
dictionary. For `kind: 'sentence'` the model returns one entry holding one sense, with no
part of speech and no example, and `normalizeSenses` enforces it whatever came back.

## The seed as a recording

### What `content.ts` becomes

Two files, split by who writes them.

```ts
// db/content.ts — authored by hand. The quiz, and the strings to record.
export type ContentEntry = {
  /** What a learner would type. The recorder's input, the variant's form,
   *  and the quiz prompt — one string doing all three, honestly. */
  query: string;
  question_id: string;
  /** Three wrong answers. The right one is the recorded sense's translation,
   *  spliced in at `correct_option`, so the two can never drift apart. */
  distractors: [string, string, string];
  correct_option: number;
};

// db/content.generated.ts — written by the recorder, reviewed, committed.
export const recorded: Record<string, LlmTranslation> = { … };
```

The question tests entry 0, sense 0 of its query's recording. Nothing selects a different
one today, and a field for it would be a guess about a need nobody has.

**The correct option is derived, not authored.** Today `options` carries the right answer as
a fourth literal, duplicating the translation. Splicing it in from the recording removes the
duplicate and the drift it invites — a regeneration that changes `ספר` cannot leave a quiz
asking for a word the dictionary no longer holds.

### The recorder

`tests/eval/generate-content.ts`, run by `npm run content:generate`. For each `query` it
calls `buildPrompt` and `createGeminiClient` — the production prompt and the production
client, the same pair the eval runner uses — parses the answer, and writes
`content.generated.ts`. A developer reads the diff and commits it.

**It takes an optional query filter and merges rather than replaces.** `npm run
content:generate -- book` re-records one string and leaves the other fifteen recordings
exactly as they are. Without that, every re-record produces a sixteen-entry diff that nobody
reads carefully — regeneration is non-deterministic enough at `temperature: 0` that wording
shifts across the whole file, and a reviewer skimming noise is how a bad recording gets
committed. With no filter it re-records everything, which is the deliberate act.

`db/content.test.ts`'s assertion that the spliced correct answer differs from every
distractor is the guard on re-recording: a regeneration that turns `ספר` into a string one of
the distractors already holds fails the build rather than shipping an ambiguous quiz
question.

**It lives in `tests/eval/` rather than `scripts/` for one concrete reason:** ADR 0001 R11
allows `providers/` to be imported only from `composition.ts`, with `tests/support/` and
`tests/eval/` exempt. Putting the recorder anywhere else means a third exemption in a grep
whose whole value is being short. ADR 0004 R4 already defines `tests/eval/` as the opt-in
real-model bucket, which describes a recorder exactly; the clause gains the recorder by name.
It is a build tool under `tests/`, which is mildly odd, and the alternative — `scripts/` plus
two ADR edits — is worse.

### The seed

`seedContent` stops writing rows itself and calls `persistEntries`, the same repository
function the translation service calls, once per query. It then reads back the term and
sense ids that produced and inserts its `questions` rows against them. Idempotence comes for
free: `persistEntries` is already `ON CONFLICT DO NOTHING` on terms and variants and
first-writer-wins on senses, so a second run writes nothing.

**Why the seed can reach the repository.** `db/seed.ts` importing `repo/vocabulary.ts` is a
sideways import that ADR 0001 R4's "may import" list does not mention — the detection grep
only looks upward, so nothing would fire, but the prose would not cover it. R4's own diagram
already draws `repo/` and `db/` as **one** layer in one box under one rule; the list simply
omitted the sibling. R4 gains `repo/*` to `db/`'s allowances, which makes the prose match the
diagram rather than granting anything new.

### What recording the seed removed

Three drafts of this design spent their complexity on the fact that seeded rows were shaped
differently from written ones. All of it is gone:

| Defended against | Why it is moot |
|---|---|
| A `source` column, or not seeding translations, to keep seeded rows out of the lookup | Seeded rows *are* lookup rows |
| Nullable `entry_rank`, `NULLS LAST`, promotion guards, fill-in-on-conflict | Every variant was written by a ranked answer |
| The enrichment path, and ranks from `max(rank) + 1` | A term is always created together with its senses |
| `ROW_NUMBER()` for a dense sense position | Ranks are contiguous `0..n`, so raw `s.rank` sorts correctly |
| Hand-authoring thirty-two Hebrew example sentences | A model wrote them; a human reviewed them |
| `book` showing `ספר` alone, with no verb sense | The recording carries both, because it is a real answer |
| Seeded sentences reaching the lookup with a save button | They are in the vocabulary because we recorded them there, so the offer is not a lie |

### Getting a new recording into a database

`persistEntries` is first-writer-wins, so running the seed against a database that already
holds a fixture writes **nothing**. Re-recording therefore has to be paired with clearing
what is there, and one statement does it:

```sql
TRUNCATE vocab_terms, sessions CASCADE;
```

`CASCADE` from `vocab_terms` reaches `term_variants`, `vocab_term_senses`,
`term_sense_translations`, `questions`, `session_questions` and `answers`. `sessions` is
named explicitly because nothing references it, so nothing would cascade to it, and a session
whose questions had vanished would be broken rather than absent. `users` is untouched.

Two callers, deliberately different in lifecycle:

- **Migration `0003` runs it once**, so the phase's own new columns land on empty tables — no
  backfills, no dropped defaults, and a migration that states the target shape instead of
  negotiating with the old one. Without it a developer's existing database keeps
  phase-4-shaped rows that `persistEntries` refuses to overwrite, leaving that database
  permanently on the old fixture while CI and every test template run on the new one.
  Carrying both shapes is what forces `max(rank) + 1` and a dense sense position back into
  the read.
- **`npm run db:reseed` runs it on demand**, then calls `seedContent`. This is what makes
  re-recording a supported operation rather than an improvised `docker compose down -v`.
  Without it, a re-recorded `content.generated.ts` would silently never reach any existing
  database.

The migration is frozen history and the command is live, so the one shared statement is
written in both places rather than imported from one.

**A reseed drops looked-up words too, not only recorded ones.** The design deliberately
cannot tell them apart — that is precisely what deleted the `source` column and everything
built on it — so "re-record one word" is really "reset the dictionary and re-record". The
loss is provider calls rather than data, since the dictionary is a cache, but it belongs in
the README beside the command rather than being discovered.

The other cost is play-test session history, which no one has asked to keep. Both must be in
the README and in the phase's plan.

## Data model

```sql
-- part of speech describes a meaning, not a word: `book` is noun and verb
ALTER TABLE vocab_term_senses ADD COLUMN part_of_speech VARCHAR(50);
ALTER TABLE vocab_terms DROP COLUMN part_of_speech;

-- "most common first", within a term
ALTER TABLE vocab_term_senses ADD COLUMN rank INTEGER NOT NULL;
ALTER TABLE vocab_term_senses ADD CONSTRAINT vocab_term_senses_rank_nonneg CHECK (rank >= 0);
ALTER TABLE vocab_term_senses ADD CONSTRAINT vocab_term_senses_term_rank_key UNIQUE (term_id, rank);

-- the bilingual example, split by what it depends on
ALTER TABLE vocab_term_senses       ADD COLUMN example_source TEXT;
ALTER TABLE term_sense_translations ADD COLUMN example_target TEXT;

-- which reading of this form this term is, as the model ranked them
ALTER TABLE term_variants ADD COLUMN language_code VARCHAR(10) NOT NULL;
ALTER TABLE term_variants ADD COLUMN entry_rank    INTEGER     NOT NULL;
ALTER TABLE term_variants ADD CONSTRAINT term_variants_entry_rank_nonneg CHECK (entry_rank >= 0);

-- one term per reading per form, and the lookup path, in one index
CREATE UNIQUE INDEX term_variants_form_entry_rank_key
  ON term_variants (language_code, lower(form), entry_rank);

-- server-issued ids, as users.id got in 0001, so no layer generates randomness
ALTER TABLE vocab_terms       ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
ALTER TABLE term_variants     ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
ALTER TABLE vocab_term_senses ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
```

No backfills and no dropped defaults, because the tables are empty when these run — the
`TRUNCATE` above precedes them. That is the second thing recording the seed bought: a
migration that states the target shape instead of negotiating with the old one.

**Two ranks, two scopes, and they are not the same number.** `vocab_term_senses.rank` orders
senses *within one headword* — "the most common meaning of `see`". `term_variants.entry_rank`
orders headwords *within one form* — "for the string `saw`, the verb reading comes first".
Neither is a frequency score. Together they are what the read sorts by.

**`language_code` is copied onto the variant so the unique index can exist.** The scope that
matters is one form in one language, but language lives on `vocab_terms` and an index reads
one table. A term's language never changes, so the copy cannot go stale. It also earns its
keep in the read, which no longer needs to join `vocab_terms` at all.

**The index does two jobs.** Its `(language_code, lower(form))` prefix is exactly the read's
predicate, so there is no separate lookup index; and its third column enforces that no two
terms claim the same reading of one form. That cannot currently happen — a written form
thereafter hits, and ranks within one write are distinct by construction — which is the point:
it is a safety net for a write bug, exactly like `UNIQUE(term_id, rank)`.

**`form` stores the string as it was written; matching is always `lower(form)`.** One rule for
both populations. A recorded `How do you do?` keeps its capital and stays a decent quiz
prompt; a learner typing `BOOK` stores `BOOK` and is matched anyway. Two case-variants of one
term cannot accumulate, because the first one written makes every later spelling of it a hit.

**`example_source` is on the sense and `example_target` on the translation**, split by what
each depends on: the source example is in the term's own language, the target is in the
learner's. Both nullable, because `example` is optional in the response. A response carries
`example` only when both halves are present.

**`sense_code` is model-supplied and exists for readability.** The column is `TEXT NOT NULL`
and needs a value. It has no functional role, because senses are never merged within a term;
`s0`/`s1` derived from rank would cost nothing and mean nothing. Three output tokens buys
`financial_institution` against `river_bank` when reading rows during a play-test.

## The two flows

`normalizeForm` is a pure function in `domain/vocabulary.ts`: trim and collapse internal
whitespace. Case is handled by `lower(form)` in the index, so normalization does not
lowercase and the stored string keeps the shape it was written in. Nothing else — no nikud
stripping, no punctuation rules, because each is a guess about learner behaviour with no
evidence behind it, and each wrong guess turns a hit into a silent miss.

### The read

```sql
SELECT s.rank, v.entry_rank, s.part_of_speech, s.example_source,
       tr.translation, tr.example_target
FROM term_variants v
JOIN vocab_term_senses s        ON s.term_id = v.term_id
JOIN term_sense_translations tr ON tr.sense_id = s.id AND tr.user_language_code = $3
WHERE v.language_code = $2 AND lower(v.form) = $1
ORDER BY s.rank, v.entry_rank, v.term_id
LIMIT 5
```

Three tables, driven by the unique index's prefix, with no join to `vocab_terms` at all —
language and the ordering key both live on the variant now. `(s.rank, v.entry_rank)` is
unique across one form's rows, and `v.term_id` closes it, so identical requests return
identical answers.

**Servability needs no column and no flag — the inner join is the test.** A term with no
translation in the language being asked for returns zero rows, which is a miss. An earlier
draft gated on the presence of an example; that was rejected because `example` is legally
optional, so a model omitting one would make an entry permanently unservable.

Both language codes come from `direction` alone: `en_he` reads an `en` term with `he`
translations, `he_en` the mirror. No user id is involved, which is why the request schema
does not change.

**`kind` is derived on a hit, not stored.** Sentences are never written, so anything in the
dictionary is a word or a phrase, and the existing `resolveKind(text, 'phrase')` settles it —
a single token is a `word`, anything else a `phrase`.

### The write

One transaction, which ends by re-reading so both paths return the same thing:

```
for each entry E of mergeEntries(answer), index i:
  1  INSERT term (language_code, E.lemma) ON CONFLICT DO NOTHING RETURNING id
       nothing returned -> SELECT the id
       a concurrent request for the same new lemma blocks here until the first commits
  2  INSERT variant (term_id, language_code, form = the queried string, kind, entry_rank = i)
       ON CONFLICT (term_id, form) DO NOTHING
  3  SELECT this term's senses
  4  none -> INSERT E's senses at ranks 0..n with their translations
5  re-run the by-form read and return it
```

Step 4 is first-writer-wins per term, and one condition covers the cases that looked
separate: a brand-new headword writes its senses, and an entry naming a headword that already
exists contributes only its variant. The concurrent double-miss is handled by step 1 rather
than by retry logic — the second transaction blocks on the unique index until the first
commits, then finds the senses already there.

Ranks are `0..n` with no gaps. An earlier draft continued from `max(rank) + 1` to survive a
term that existed without servable senses; the destructive migration means no such term
exists, which is why the read can sort on the raw rank rather than a computed position.

**Step 5 is what makes the two paths identical.** Returning only what was just written would
give the writer a different answer from the next reader whenever the queried form was already
a variant of another term. Re-reading costs one query and makes the invariant literal: **the
response is always the same merge the next lookup would produce.**

### Worked through, end to end

```
1  'see'   miss -> entries [see]
             t-see; variant (t-see,'see',entry 0)
             senses rank 0 לראות · 1 להבין · 2 לפגוש
             -> [לראות, להבין, לפגוש]

2  'saw'   miss -> entries [see, saw]
             t-see exists, senses kept
             t-saw created, senses rank 0 מסור · 1 לנסר
             variants (t-see,'saw',entry 0) · (t-saw,'saw',entry 1)
             -> [לראות, מסור, להבין, לנסר, לפגוש]

3  'saw'   HIT, no provider call, the same five

4  'saws'  miss -> entries [saw]
             t-saw exists, senses kept; variant (t-saw,'saws',entry 0)
             -> [מסור, לנסר]

5  'see'   HIT -> its own three. Correctly no מסור: 'see' is not ambiguous
```

Step 2 is the case the entries model exists for: both readings answered and both written, so
step 3 is free and step 5 stays correct. Asked in the other order — `saws` first — t-saw
would exist alone and a later `saw` would still miss, because no alias was ever synthesized
for it; the model would then return both entries exactly as in step 2.

**A failed write must not lose a translation the learner already paid for.** The write is
awaited, and a throw is caught, logged at error level, and the parsed entries are flattened
and served with a `200` regardless. A broken persistence path shows up as a log line and as
every lookup costing a provider call — not as a `502` on a request the model answered.

New log lines: `vocab_cache_hit` (term count, sense count), `vocab_persisted` (entry count,
terms created), `vocab_persist_failed`. The existing `translated` line stays.

## Server layers

```
db/migrations/0003_*.sql   the delete and the shape above
db/schema.ts               the new columns, constraints and index
db/content.ts              the quiz authoring and the strings to record
db/content.generated.ts    the recorded answers
db/seed.ts                 replays the recording through persistEntries
domain/vocabulary.ts       normalizeForm, languagesFor, mergeEntries,
                           entriesToRows, rowsToSenses. Pure
repo/vocabulary.ts         findSensesByForm, persistEntries
services/transaction.ts    Repos gains `vocab: VocabRepo`
services/translations.ts   gains `transaction`; read -> model on a miss -> write
composition.ts             binds createVocabRepo(tx), passes transaction to the service
tests/eval/generate-content.ts   the recorder
routes/translations.ts     UNCHANGED
```

`routes/` not moving is the point worth stating: the endpoint, its three statuses, its
published document and every existing route test are untouched, because reuse and
persistence are entirely a property of how the use case is satisfied.

`domain/vocabulary.ts` stays pure under ADR 0001 R3 — it maps between rows and entries and
knows nothing about Drizzle, so the row shapes it accepts are declared locally, the same
arrangement `domain/translation.ts` already uses for `TranslationPrompt`.

## The contract change, and how it stays off the wire

```ts
const LlmSenseSchema = TranslationSenseSchema.extend({ sense_code: z.string().min(1).max(60) });

const LlmEntrySchema = z.object({
  lemma: z.string().min(1),
  senses: z.array(LlmSenseSchema).min(1).max(5),
});

export const LlmTranslationSchema = z.object({
  kind: TranslationKindSchema,
  entries: z.array(LlmEntrySchema).max(3),
});
```

`TranslationSenseSchema` is shared with the response, so `sense_code` goes on an extension
rather than on the shared shape. `TranslationRequestSchema` and `TranslationResponseSchema`
are byte-identical to phase 9, so the published OpenAPI document does not move and
`src/openapi.test.ts` needs no change. `sense_code` cannot reach a client by construction:
the response is built from the rows the write re-read, and on the write-failed fallback path
`rowsToSenses` builds each response sense field by field rather than spreading.

An empty `entries` array is the "no translation" answer — `200` with `senses: []`, as phase 9
defined it. `entries[].senses` has `min(1)` because an entry with no senses is meaningless; a
model returning one fails the parse and yields `TranslationUnreadable`, which is correct —
that is a malformed answer, not an empty one.

**The prompt** asks for: every headword the input could belong to, most likely first, at most
three, **one entry per headword** with senses spanning parts of speech kept together; for
each headword its own senses ranked most common first, at most five; each sense with a part
of speech, a bilingual example and a short snake_case `sense_code`; `kind` for the input as a
whole; and for a `sentence`, exactly one entry with one sense carrying the translation alone.
`book → one entry, senses ספר and להזמין` goes in the instruction as a worked example, since
the nested shape otherwise invites returning one sense per entry. Phase 9's three rules — a
fixed expression is a `phrase` even when imperative, an idiom is translated by meaning, a
sentence returns one sense — carry over unchanged.

## Testing

Placement follows ADR 0004 — the folder decides the bucket — and no bucket is added.
Integration and e2e stay black-box: what varies is the database and MockServer's
expectations, never a fake injected into the server.

### Unit (`src/**/*.test.ts`, Docker stopped)

| File | Covers |
|---|---|
| `domain/vocabulary.test.ts` **new** | `normalizeForm` — trim, internal whitespace collapse, casing left alone, a Hebrew string untouched; `languagesFor` both directions; `mergeEntries` concatenating same-lemma entries in order and leaving distinct lemmas alone; `entriesToRows` assigning `entry_rank` by entry order and sense ranks `0..n`; `rowsToSenses` building `example` only when both halves are present and never emitting `sense_code` |
| `domain/translation.test.ts` | extended: the prompt asks for entries, one per headword, each with its own senses and `sense_code`; `parseLlmTranslation` accepts a two-entry payload, rejects an entry missing `lemma`, rejects an entry with an empty sense list, and treats `entries: []` as the empty answer rather than as unreadable |
| `services/translations.test.ts` | extended, against `createFakeTransaction` widened to a partial `Repos` plus the existing `createFakeLlmClient`: a hit calls the client **zero** times; a miss calls it once then writes every entry; the response comes from what the transaction returned rather than from the model's reply; a throwing write still yields `200` with the flattened entries; a `sentence`, an empty entry list and an `LlmUnavailable` each write nothing |
| `db/content.test.ts` | rewritten around the split: every `query` has a recording; every recording has at least one entry with at least one sense; `distractors` are three and distinct; `correct_option` is in range; and the spliced correct answer is not equal to any distractor |
| `packages/core/src/api/schemas.test.ts` | extended: `LlmTranslationSchema` requires `entries`, each with a `lemma` and at least one sense carrying `sense_code`; the response's sense shape is unchanged and drops `sense_code` |

### Integration (`tests/integration/**`, mirroring the `src/` path)

| File | Covers |
|---|---|
| `repo/vocabulary.test.ts` **new** | The read against real Postgres: `Book` finding `book`, rank ordering, the five cap, and a term with no translation in the asked-for language returning nothing. Then `persistEntries`: a term per entry, first-writer-wins on an entry naming an existing lemma, a variant per entry carrying its `entry_rank`, the ids it returns matching what it wrote, and two overlapping transactions on one new lemma ending with a single sense set both callers see |
| `repo/vocabulary.order.test.ts` **new** | The merge, the phase's most load-bearing rule, with rows inserted directly so nothing depends on a model: a form on two terms returns **both** headwords' senses; repeated identical queries return them in the same order; ranks interleave rather than block, so a five-sense `see` cannot push a rank-0 `saw` off the cap; `entry_rank` decides which headword leads inside a rank; and a second term claiming an occupied `entry_rank` for one form is rejected by the unique index |
| `services/translations.test.ts` **new** | The use case against a real database and MockServer: a miss, then the same string again producing **zero** MockServer requests. That `verify` is the assertion the phase exists for. Plus the `saw` sequence — a two-entry answer writes two terms, and the immediate re-ask is free and identical |
| `routes/translations.test.ts` | extended: the same string twice over HTTP; a recorded string answering from the seed with its example pair and no MockServer request; and a two-entry answer flattening into one ranked list over the wire |
| `db/seed.test.ts` | rewritten: the seed writes what the recording says — terms, variants with `entry_rank`, senses with rank, POS and examples, translations — its questions point at the ids it wrote, the correct option matches the recorded sense, and a second run changes nothing |
| `db/reseed.test.ts` **new** | The operation that makes re-recording possible, which would otherwise be verified only by a developer running it: after a lookup has written its own term, `TRUNCATE vocab_terms, sessions CASCADE` plus `seedContent` leaves exactly the recording — the looked-up term gone, `users` intact — and a changed recording takes on the second run where a bare re-seed would have written nothing |
| `composition.test.ts` | extended: the translations service now receives a transaction |

The seed test is where "the seed is a recording" is actually verified: it asserts the rows
the seed produces are the rows `persistEntries` produces, rather than asserting a shape
authored twice.

### e2e

`translate.spec.ts` gains one spec, shaped to survive a database that already holds the
string: register the expectation, look it up, **clear every expectation**, then look it up
again. If the answer still appears it came from Postgres, because there is nothing left for
the provider to answer with. A "the second lookup makes no request" assertion would not
survive a re-run, since e2e shares one long-lived database across specs and nothing truncates
it between runs.

### Evals

Tier 1 gains two invariants: at least one entry unless the case expects none, and every entry
carrying a non-empty `lemma` with senses that each carry a `sense_code`. Tier 2 pins the two
axes against each other, because the nested shape can fail in either direction:

- `saw` must return **two entries** — the failure the entries model replaced.
- `book` must return **one entry with two senses** — the failure the nested shape invites,
  where a model splits by part of speech or returns one sense per entry.
- `running` resolves to a single entry whose lemma is `run` and whose senses are `run`'s.

`npm run content:generate` is not an eval and is not scored; it shares the bucket because it
shares the provider client.

## ADR consequences

**No new ADR, and no new detection command.**

### ADR 0001 R8 — amended a second time

The use case is now: normalize, **read**, on a miss call the provider for one to three
seconds, **write**, respond. That is two `transaction(...)` calls, and R8 — amended in phase
9 to *"a use case that touches the database is exactly one `transaction(...)` call"* —
permits one.

Holding one transaction open across the provider call was rejected outright: ten seconds of
an idle pooled connection per lookup, one per concurrent learner. Two short transactions with
the call between them hold nothing and race harmlessly, because the write is idempotent
against `UNIQUE(language_code, lemma)` and `UNIQUE(term_id, form)`.

Amended wording: *a use case opens at most one **write** transaction; a read preceding
third-party I/O may be its own.*

**The alternative, recorded rather than taken.** A read-only `Query` seam —
`createQuery(db, bind)` beside `createTransaction`, bound to a read-only projection of the
repositories — would keep R8's wording untouched and make "one write transaction per use
case" a type-level guarantee rather than prose, the way `Transaction` already makes it
impossible for a service to hold a `Db`. It would also save a `BEGIN`/`COMMIT` round-trip on
a cache hit. Declined for simplicity while one use case needs it: a new type, factory, bind
and read-only projection, plus a decision about `login`, a pure read that opens a transaction
today. **ADR 0001 records it as a future option to revisit for the performance gain.**

R8's detection command greps for `\.transaction(` — the mechanism, `db.transaction(`, which
still has exactly one call site. The "how many per use case" half was never machine-checked
and is not now, under either option.

### ADR 0001 R4 — `db/` may import `repo/`

R4's diagram draws `repo/` and `db/` as one layer in one box under one rule, but its "may
import" list omits the sibling, so `db/seed.ts` calling `persistEntries` would be uncovered
prose rather than a violation — the detection grep only looks upward. R4's list gains
`repo/*` for `db/`, making the prose match the diagram. No detection command changes, because
the rule that matters, *persistence must not reach upward*, is unaffected.

### ADR 0002 R6

The factory list gains `createVocabRepo`.

### ADR 0004 R4

The `tests/eval/` clause names the recorder alongside the eval runner: the bucket is the
opt-in real-model code, which is a description of both. Its two existing checks are
unchanged, since `generate-content.ts` is neither a `*.test.ts` nor imported by `src/`.

### No new check

Nothing this phase adds is expressible as a regex, so
`scripts/check-adr-0001-layered-architecture.sh` stays at seventeen checks and there is no
planted-violation step to run. Stated rather than left silent, because phase 9 established
that a check must be shown to fail before it is trusted — the counterpart being that a phase
adding none should say so.

## Prior art

Earlier drafts got the form-to-entry relationship wrong in both directions — one let a form
gather senses from two headwords in planner order, the other forced one headword per form
and deleted half the answer. These are the sources that settled it, recorded because the
question returns the first time someone reads the merge and assumes it is a bug.

**Senses belong to the entry, never to a surface form.** [LMF / ISO
24613](https://en.wikipedia.org/wiki/Lexical_Markup_Framework) structures a lexicon as
`LexicalEntry → Lemma + Forms → Senses`; [OntoLex-Lemon](https://www.w3.org/2016/05/ontolex/)
gives a `LexicalEntry` one `canonicalForm`, zero or more `otherForm`s, and its senses.
Nothing hangs senses off an inflected form. That is why each entry carries its lemma's senses
rather than the typed string's.

**A form indexing into several entries is normal, and every source returns all of them.**
Merriam-Webster's [JSON API](https://www.dictionaryapi.com/products/json) carries every
inflection in a `meta.stems` array — *"all of the entry's headwords, variants, inflections…"*
— so `saw` is a stem of both `see` and `saw`, and a query returns both entries.
[WordNet's morphy](https://wn.readthedocs.io/en/latest/guides/lemmatization.html) returns
every candidate lemma, and NLTK's habit of picking the shortest is a known-bad shortcut.
[Wiktionary](https://en.wiktionary.org/wiki/Wiktionary:Entry_layout) keys the page on the
spelling and nests entries by etymology then part of speech, showing the noun `saw` and the
verb form side by side. Asking the model for `entries` is this design adopting that shape at
the point the data is produced, which is the only place it can be got right.

**Entry identity carries an explicit disambiguator, where entries are split at all.**
Merriam-Webster's `meta.id` is `battle:2` — headword plus a `hom` number. [Wikidata
Lexemes](https://www.mediawiki.org/wiki/Extension:WikibaseLexeme/Data_Model) make noun
`color` and verb `color` two lexemes, related by *homograph lexeme* (P5402). This design does
**not** split one lemma per part of speech — `book` is one term whose senses span noun and
verb — and `mergeEntries` exists precisely because the sources' convention pulls a model the
other way. Splitting would need a homograph number and another level of nesting for no gain
a flat response could show.

**What none of them settles is order across entries**, because none returns a flat list —
Merriam-Webster has an editorial homograph number, Wiktionary has section order on a page.
Phase 9's response is flat, so the ordering is ours: `entry_rank` from the model, merged
round-robin under sense rank so no headword's top sense is crowded out.

**From the other direction**, [translation
memory](https://www.tm-town.com/blog/the-fuzziness-of-fuzzy-matches) keys on the exact source
segment and shows anything less as a scored fuzzy match rather than substituting it silently.
That is the discipline behind normalizing the lookup key and nothing else, behind writing a
variant only for the string actually queried, and behind never guessing at a near-match.

## Documents this phase adds and edits

| Document | Change |
|---|---|
| `docs/adr/adr-0001-layered-architecture.md` | R8's second amendment and the `Query` seam as a future option; R4's import list gains `repo/*` for `db/`; a third revision note in the header |
| `docs/adr/adr-0002-di-with-closures.md` | R6's factory list gains `createVocabRepo` |
| `docs/adr/adr-0004-test-topology.md` | R4's `tests/eval/` clause names the recorder beside the eval runner |
| `README.md` | The phase index; *Reading the API* corrected, since a repeat lookup no longer reaches a paid third party; `npm run content:generate` and its `-- <query>` filter documented; `npm run db:reseed` documented beside the warning that it drops looked-up words as well as recorded ones; and a loud note that migration `0003` clears the quiz tables and session history |
| `package.json` | `db:reseed`, and `content:generate` alongside the existing `eval` script |

## Out of scope

- **Per-learner ownership and any "my words" screen.** Nothing records who asked.
- **Reading the vocabulary.** No endpoint over the dictionary; `psql` is the only way to see
  it.
- **Grouping the response by headword.** When `saw` returns `see`'s and `saw`'s senses the
  learner sees one flat list with no sign two words are in it; the per-sense
  `part_of_speech` is the only hint. *Prior art* records what a grouped response would adopt.
- **A lookup phrased as a question.** Typing `What is the meaning of "book"?` is classified a
  sentence and translated as one. Extracting the term from a wrapper question is a new
  capability, not a phase 10 fix.
- **Generating quiz questions from looked-up words.** The data is shaped for it; the
  inheritance is that a lookup's `form` is whatever the learner typed, casing included.
- **Caching sentences, empty answers and failures.** Each keeps costing on every repeat.
- **Invalidation, TTL, refresh and sense merging within a term.** First-writer-wins is
  permanent, and re-recording the seed is the only supported way to change stored content.
- **Rate limiting and cost caps.** Reuse lowers the bill; nothing bounds it.
- **The read-only `Query` seam.** Recorded in ADR 0001 as a future option.
- **A third language.** `direction` still has two values.

## Risks

- **Migration `0003` deletes quiz history.** `answers`, `session_questions`, `sessions` and
  `questions` go, along with the seeded dictionary they point at. `users` survives. This is
  the deliberate price of one data shape instead of two, and it must be in the README and the
  plan rather than discovered by a developer mid-play-test.
- **`db:reseed` also drops every looked-up word**, because nothing distinguishes a recorded
  row from a written one. Re-recording a single string therefore resets the whole dictionary.
  The loss is provider calls rather than data, but a developer who reseeds during a
  play-test to fix one bad entry pays for every other word again.
- **The recording freezes the seeded words.** Sixteen strings answer from a fixture that was
  true on the day it was generated. Re-recording is a deliberate act with a reviewable diff,
  which is the point — but nobody will do it on a schedule.
- **The recorder needs a real API key and spends money**, like the eval bucket. It runs on
  demand, never in CI, and a stale `content.generated.ts` is invisible until someone looks.
- **The dictionary is permanent and there is no way to correct it from the app.** A poor
  answer for a new headword is served to everyone from then on. For a play-test the
  operational answer is a `DELETE` against the local database, which belongs in the README.
- **The entry list is model-supplied and can be wrong** — a missed reading, an invented one,
  or a wrong lemma filing a word under the wrong headword. The `saw`, `book` and `running`
  eval cases cover the shapes. A missed reading is the quiet failure: nothing in the data
  shows a second entry should have existed, and a form's answer is fixed once written.
- **The five cap can hide a sense.** Two entries with three senses each yield six rows and
  the tail is cut. Round-robin ordering means each headword keeps its most common sense; a
  third-ranked one can vanish.
- **Every distinct surface form costs one provider call**, because no lemma alias is
  synthesized. `run` after `running` is a second call — the deliberate price of never
  guessing at a string nobody typed.
- **Ambiguous forms are slower and dearer**, since the model returns two or three entries
  with their examples. Most strings have one entry, so typical latency is unchanged.
- **Reuse changes what the play-test measures.** A string already in the dictionary answers
  in milliseconds, so latency findings depend on which words a tester happens to try. Phase
  9's "latency is the experience" risk is not resolved, only made uneven.
- **The confirmation still overstates what happened.** `שלך` was kept deliberately; the save
  is real but shared.

## Success criteria

1. The same string asked twice makes exactly one provider request — MockServer `verify` in
   integration, expectations cleared in e2e.
2. A lookup of `saw` on an empty dictionary returns **both** `see`'s and `saw`'s senses in one
   answer and writes both headwords; no second string has to be typed first.
3. Repeating that lookup returns the identical ordered list with no provider request, and no
   headword's top sense is crowded out by another's tail.
4. `book` comes back as **one** entry carrying both `ספר` and `להזמין`, so **more** works —
   from the recording on a seeded database, and from the model on an empty one.
5. On a freshly migrated database the sixteen recorded strings answer with no provider
   request, and every row the seed wrote is byte-identical to what `persistEntries` would
   have written for the same answer.
6. Re-recording is a supported operation, not folklore: `npm run content:generate -- book`
   changes one recording and leaves fifteen untouched, and `npm run db:reseed` then makes a
   database serve it. Running the seed alone against a populated database still writes
   nothing, which is why the command exists.
7. The published OpenAPI document is byte-identical to phase 9's, and `apps/mobile` has no
   changed file.
8. `npm run test:all` and `npm run e2e` are green with no network access and no API key.
   `npm run content:generate` is the only new command that needs either, and it is absent
   from every CI job.
9. `npm run lint:arch` passes and still reports seventeen ADR 0001 checks: no new script, no
   new check, no planted-violation step.
10. A write that throws still returns `200` with the translation, and logs
   `vocab_persist_failed`.
