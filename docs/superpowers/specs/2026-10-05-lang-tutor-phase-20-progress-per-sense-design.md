# Phase 20 — Progress per sense

- **Status:** Design approved section by section, 2026-10-05; implemented on branch
  phase-20-progress-per-sense. Deviations from the approved design are folded in.
- **Date:** 2026-10-05
- **Source:** the one-pager `drafts/2026-10-05-progress-per-sense-one-pager.md`, the design
  dialogue recorded here, and a side research on knowledge dimensions
  (`drafts/2026-10-05-knowledge-dimensions-decision.md`, with its prompt beside it). `drafts/`
  is gitignored, so the verdict this spec depends on is restated in §1.
- **Builds on:** phase 19 (list sessions, skip, `GET /sessions/{id}`). The branch starts from
  `phase-19-next-enrollment-session`.
- **Touches:** ADR 0001 R8 (two new dependent writes), ADR 0002 R6 (factory list), ADR 0003
  (the vocabulary and session wire contracts).

## Goal

A learner can see, per saved word, how well they know it. Every saved sense carries a level per
knowledge dimension, the level only ever rises, and the saved list and the results screen show
it. Session picking stays uniform: this phase records and shows progress, it does not act on it.

**Done means:**

1. On the saved list, the learner sees each word's level as one of five names.
2. The results screen lists every practised saved word with its level, and highlights the words
   that moved up in that session.
3. The saved list can be sorted and filtered by level.
4. A level never goes down.
5. A word never practised shows the lowest level.
6. `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass. `npm run eval`
   is untouched: this phase adds no prompt.

## Scope

**In:**
- the `sense_progress` and `session_progress` tables, and their migration;
- five knowledge dimensions per sense, stored from day one, one of them live;
- the step rule as a pure domain function, run when a session ends;
- `level` on the list and detail payloads, `sort` and `level` on the list query, and a
  `progress` block on a completed session;
- the level badge, list sorting and filtering, the per-dimension detail, and the results
  screen's practised-words section;
- a recompute script for when the rule changes.

**Out:**
- weak-first or spaced-repetition picking;
- an enrollment-level number or trend on the home screen;
- a "days until the next level" hint (§8 names it as the first remedy if sessions where nothing
  moves become common);
- any status for a word that is not on the saved list;
- exercise types beyond today's multiple choice, and the voice indicator on the list row that
  arrives with them;
- a new ADR or check script.

---

## 1. The research verdict, restated

**Five dimensions per sense, two modalities times two directions plus spelling. Progress is
per (enrollment, sense, dimension). Within a modality, productive success also credits
receptive; nothing crosses modalities.**

| Dimension | Meaning |
|---|---|
| `written_receptive` | given the written word, know its meaning |
| `written_productive` | given the Hebrew meaning, produce the written word; spelling judged leniently |
| `spoken_receptive` | given the spoken word and no text, know its meaning |
| `spoken_productive` | given the Hebrew meaning, say the word so that it is recognised |
| `spelling` | write the form exactly; credited only by strict typed answers |

The reasons, in brief: phonological and orthographic vocabulary tests load on different factors
(Cheng & Matthews 2018); receptive and productive form an implicational hierarchy, recognition
before recall (Laufer & Goldstein 2004), so they are ordered rather than independent; the
measured productive gap is mostly form precision, and Hebrew-L1 learners of English have a
plateauing vowel-spelling deficit (Webb 2008; Martin 2017); 96% of heritage Russian speakers in
Israel speak the language and 41% read it, so voice and text must not merge.

**Spacing, not count, is the evidence.** Optimal gaps for durable retention run about 1, 7 and
21 days (Cepeda et al. 2008), same-day repeats add little, and four-option multiple choice
over-credits by 11–26% (Gyllstad et al. 2015). The step rule in §3 is the discount: a level
rises on an all-correct day, after a gap.

**The badge** is the average over live dimensions (decided in the dialogue, departing from the
research's single-dimension badge; §3). The research's main risk stands: an up-only badge can
over-claim, and the remedy to watch for is a recall-format gate on multiple choice, or a hint of
progress toward the next level if learners see too many sessions where nothing moves.

Decisions from the dialogue, beyond the research:

- **Only answers given while the sense is saved count.** No retroactive credit from seed
  sessions. A sense with no progress rows is simply not saved.
- **Days are UTC calendar days.** The gap is what matters, not where the learner is. No
  timezone is stored anywhere. A session's day is the UTC date of its last answer.
- **A skipped session's answers count.** They are real answers, and a wrong one restarts the
  gap like any other.
- **No hidden score.** The row is a level and two dates; the answer log is the hidden truth.

## 2. Data model

### `sense_progress`

```
sense_progress
  enrollment_id  text not null
  sense_id       text not null
  dimension      text not null  check in ('written_receptive','written_productive',
                                          'spoken_receptive','spoken_productive','spelling')
  level          int  not null  default 1   check between 1 and 5
  last_step_on   date            -- UTC day of the last step up
  last_wrong_on  date            -- UTC day of the last wrong answer

  PRIMARY KEY (enrollment_id, sense_id, dimension)
  FOREIGN KEY (enrollment_id, sense_id) → vocabulary_entries ON DELETE CASCADE
```

- **Five rows are inserted with the entry**, in the save transaction. "Not practised" is a
  level 1 row, never a missing one, so a dimension going live later needs no backfill.
- **Unsave cascades the rows away.** A re-save starts at level 1, which is "only while saved"
  applied to the entry's whole lifetime.
- **The two dates are the whole state** the rule in §3 needs. Nothing else is stored, and
  nothing in this phase reads anything else.

### `session_progress`

```
session_progress
  session_id    uuid not null → sessions ON DELETE CASCADE
  sense_id      text not null
  dimension     text not null
  level_before  int  not null
  level_after   int  not null

  PRIMARY KEY (session_id, sense_id, dimension)
```

One row for every dimension of every saved sense the session practised, moved or not: all
five, not only the ones that received evidence. A row nothing moved has
`level_before = level_after`. The results badge averages over every live dimension, so a live
dimension the session did not exercise still needs its level at that moment. The rows let a
client re-read a completed session's results; the app does not (§5). A recompute rebuilds them
from the answer log.

### Live dimensions

`LIVE_DIMENSIONS` is a domain constant, today `['written_receptive']`. A dimension is live when
the app has an exercise type that feeds it. The list query receives the set as a parameter.

### Badges

- **A sense's badge** is the mean of its `level` over the live dimensions, rounded to the
  nearest integer, ties up.
- **A word's badge** on the list is the mean over its saved senses and the live dimensions,
  rounded the same way. One number per row, across senses.
- Both are computed by `badge(levels)` in `packages/core` (§3), so server and app agree.

### Migration

One drizzle migration creates both tables and inserts five level 1 rows for every existing
`vocabulary_entries` row. No session is re-evaluated: only answers given while saved count,
and nothing was saved before phase 18.

### Indexes

The list's level sort and filter aggregate over one enrollment's entries, which
`vocabulary_entries_enrollment_lexeme_idx` already narrows.

**`sense_progress_enrollment_dimension_idx (enrollment_id, dimension, sense_id, level)`** is a
covering index, added from the start, that serves them as an index-only scan of one
enrollment's live-dimension rows. It was measured while planning at the plan test's volume: a
20k-word enrollment's first page took 35 ms without it and 12 ms with it, for every sort. The
plan test (§7) pins it. It asserts that every list query shape uses this index, because the
50 ms budget alone is not enough: a planted drop of the index made those assertions fail while
the budget still passed.

## 3. The rule

### Pure functions, `apps/server/src/domain/progress.ts`

ADR 0001 R3: no clock, no randomness. The day is passed in.

- **`evidenceFor(answer)`** maps one answered question, an `AnsweredQuestion`
  (`{ senseId, type, correct }`), to pieces of evidence, `{ dimension, correct, capped }`. Today
  every question is multiple choice target to Hebrew, so it returns one uncapped
  `written_receptive` piece. The table below is the cases later exercise types add; it is
  recorded so the state and the rule need no change when they arrive.

  | Dimension | Full credit from | Capped at 3 from | Downward credit from |
  |---|---|---|---|
  | `written_receptive` | multiple choice target → Hebrew (today); listening with the written word shown | flashcard self-grade | correct `written_productive` pieces |
  | `written_productive` | typed translation Hebrew → target; typed cloze; a near miss by one letter on a word of five or more letters counts as correct here | multiple choice Hebrew → target; self-grade | — |
  | `spoken_receptive` | listening then choose, no text shown; dictation | self-grade | correct `spoken_productive` pieces |
  | `spoken_productive` | speaking with recognition; a recogniser reject is no evidence, never wrong | self-grade | — |
  | `spelling` | an exact typed answer from translation, cloze or dictation; a near miss is a wrong spelling piece | — | — |

  Downward credit carries only successes: a correct productive piece is also a correct
  receptive piece, but a wrong one says nothing about recognition and does not restart the
  receptive gap.

- **`advance(row, pieces, day)`** applies the step rule to one row and returns the new row.
  1. If any piece is wrong, `last_wrong_on := day`. No demotion, ever.
  2. Step up if all of these hold:
     - at least one correct piece and no wrong piece today. `last_wrong_on` already equal to
       `day` from an earlier session today also blocks it;
     - `last_step_on ≠ day`: at most one step per day per dimension;
     - `day` minus the later of `last_step_on` and `last_wrong_on` is at least the gap for the
       current level: **0 days from level 1, 1 from 2, 7 from 3, 21 from 4**. A missing date
       passes. Days are whole UTC calendar days between two dates;
     - `level + 1` is within the cap: 3 if every correct piece today is capped, 5 otherwise.
  3. On a step, `level := level + 1` and `last_step_on := day`.

  Level 5 therefore needs four all-correct days spanning at least 29 days, and a word first
  practised today reaches level 2 today.

- **`badge(levels)`**: the rounded mean described in §2, exported from `packages/core/domain`
  because the app's detail screen computes a sense badge from five levels with the same
  arithmetic.

- `DIMENSIONS`, `LIVE_DIMENSIONS`, `GAP_DAYS` and `CAPPED_MAX_LEVEL` sit beside them.

### Where it runs

**When a session ends, by completion or by skip, over whatever answers it has**, inside the
same transaction as the status change:

1. load the session's answers joined to their questions' sense ids;
2. load the progress rows for those senses in this enrollment. A sense with no rows is not
   saved and is skipped: the "only while saved" rule with no extra check;
3. group evidence by sense and dimension; call `advance` on each row with **the day being the
   UTC date of the session's last answer**. A completion's last answer is the one being
   recorded, so it is now; a skip has no timestamp of its own, and the last answer is the
   only end time both this path and the recompute can read, so neither needs a new column;
4. write the changed rows, and one `session_progress` row for each of the five dimensions of
   every sense that received evidence.

These are **dependent writes** with the status change (ADR 0001 R8): a completed or skipped
session with no progress written, or progress written for a session that did not end, would
each be wrong. They share the one transaction `submitAnswer` and `skipSession` already open.
R8's dependent/independent judgement is recorded here, as it asks.

**What never runs the rule:** a session skipped with no answers, including one skipped while
preparing; a replayed final answer; a seed question about a sense the learner has not saved.
A seed question about a sense they *have* saved counts, because the rows exist.

**Accepted:** a learner who sees a hard question and skips before answering avoids a possible
wrong answer. They cannot dodge one already given and they lose the rest of the session.
Nothing is built against it.

### Recompute

`db:progress:recompute` rebuilds `sense_progress` and `session_progress` from the answer log
and `vocabulary_entries.created_at`, replaying ended sessions in order through the same
`advance`. For when the rule changes. Nothing runs it automatically.

It lives in `apps/server/src/db/progressRecompute.ts`, behind a `--recompute-progress` flag on
`db/cli.ts`, and is not a service. ADR 0001 R4 forbids `db/` from importing `services/`, and
`db/cli.ts` is the CLI's composition root. So it repeats the session service's orchestration
over the same repository and domain functions, and an integration test checks that a
recompute writes back exactly what the live path wrote.

## 4. API

All schemas live in `packages/core` (ADR 0003); every route uses `createRoute`. Three payloads
grow; no route is added.

### List — `GET /enrollments/{id}/vocabulary` (changed)

Query gains:

```
sort   'newest' | 'level_asc' | 'level_desc'   default 'newest'
level  1..5                                      only words whose badge is exactly this
```

Each word gains `level: 1..5`. The cursor encodes the sort it was issued under and that sort's
key; a cursor replayed under another sort is a 400 `InvalidCursor`, like a malformed one today.
A newest cursor keeps phase 18's two-element encoding, so one already in flight stays valid. A
level-sort cursor carries four elements: the save time, the lexeme id, the sort and the level.
Under a level sort, ties break by newest save and then lexeme id, so paging is stable.

Under the newest sort a word is never served twice in one walk. Under a level sort, a word
whose level changes mid-walk (a save lowers its mean, a finished session raises it) may be
served again or passed over.

### Detail — `GET /enrollments/{id}/vocabulary/words/{lexeme_id}` (changed)

The word gains `level`, which is `null` for a word with nothing saved. The route answers 200
for such a word, and it has no badge. Each **saved** sense gains:

```
progress: { level, dimensions: { written_receptive, written_productive,
                                  spoken_receptive, spoken_productive, spelling } }
```

An unsaved sense has no `progress` key.

### Session end — `POST /sessions/{id}/next-step` and `GET /sessions/{id}` (changed)

The completed shape gains:

```
progress: [{ sense_id, form, translation, level_before, level_after }]
```

One item per practised sense that was saved, in session order. `form` is the prompt the learner
saw, `translation` the correct answer. The levels are badges over the live dimensions, computed
from `session_progress`, so the app does no arithmetic. The read route carries the same block
for a completed session, so a client can re-read its results; the app does not (§5). A seed
session with nothing saved returns `[]`.

In the session service, `submitAnswer` and `getSession` return `SessionResult = SessionRecord &
{ progress: ProgressChange[] }`. It is an intersection, so every existing caller that reads
record fields keeps compiling.

### Errors

No new error types. A bad `sort` or `level` is the standard 400; a cursor under the wrong sort
is the existing `InvalidCursor`; unknown enrollment, lexeme and session keep their 404s.

## 5. Mobile

### Level names

| Level | English | Hebrew |
|---|---|---|
| 1 | New | חדשה |
| 2 | Seen | נחשפה |
| 3 | Familiar | מוכרת |
| 4 | Known | ידועה |
| 5 | Mastered | בשליטה |

Feminine, agreeing with מילה. `strings.levelName(level)` holds them.

### `LevelBadge`

Five pips with `level` of them filled, the name beside. One component for every screen, so the
ladder looks the same everywhere.

### Saved list

Each row gains the badge under the lemma. Above the list, two rows of chips:

- sort: **חדשות** (default), **רמה עולה**, **רמה יורדת**;
- level: the five names, one selectable at a time, tap again to clear.

Changing either reloads from the first page. `useVocabulary` holds `sort` and `level` and passes
them to the api client. A second empty state, "אין מילים ברמה הזו", keeps a filter with no
matches from reading as an empty list.

### Word detail

The word's badge sits in the header. Each saved sense shows its badge, and under it the five
dimensions as a compact list: name and level for a live one, **טרם תורגל** for the others.
Unsaved senses are unchanged.

### Results

A new section above the missed list, **המילים שתרגלת**: one row per `progress` item, with the
form, the translation and the badge. A row whose level rose gets a highlighted **עלתה לרמה X**
tag, and those rows sort first. Nothing renders when the list is empty, which is every seed
session. Headline and score are unchanged.

### State

The results screen reads `progress` from the completing next-step response the way it reads the
score. `useSession` passes it through. The read route carries the block too, as §4 says, but the
app does not need it. Nothing new is stored on the device.

## 6. Errors

| Case | Status | Error |
|---|---|---|
| bad `sort` or `level` on the list | 400 | `{ error: 'invalid request' }` (existing) |
| cursor issued under another sort, or malformed | 400 | `InvalidCursor` (existing) |
| unknown enrollment, lexeme or session | 404 | existing |

## 7. Testing

### Unit, server

- `advance`: a step from each level at exactly the gap and one day short; the all-correct
  day; a wrong piece only setting `last_wrong_on`; one step per day across two sessions; the
  gap measured from the later of the two dates; a cap of 3 with capped evidence only, no cap
  with one uncapped piece; missing dates passing; nothing ever lowering a level.
- `evidenceFor`: today's multiple choice gives one uncapped `written_receptive` piece.
- `badge`: rounding, ties up, live dimensions only.
- `submitAnswer` and `skipSession` with fakes: progress written on completion and on a skip
  with answers; nothing on a skip without; nothing on a replay; a sense with no rows skipped.
- cursor: a cursor carries its sort, and one under another sort is refused.

### Unit, mobile

Mobile tests in this repo are pure-module tests: nothing renders a component. The screens'
progress rules sit in pure functions in `apps/mobile/src/progress.ts`, and the tests call them.

- `pipsFor`, the pure function `LevelBadge` draws its pips from, fills as many of the five as
  the level. This is what the badge test covers.
- the api client sends `sort` and `level` when given.
- `dimensionRows` lists the five dimensions in order, with no level for the four not live,
  which the detail shows as טרם תורגל.
- `practisedRows` puts the words that rose first, each group in session order, and is empty for
  an empty list.
- the list's reload from the first page and its level-specific empty state are covered end to
  end (`e2e/tests/progress.spec.ts`), not by unit tests.

### Integration, real Postgres

- save inserts five rows; unsave removes them; re-save starts at level 1.
- a completed session writes `sense_progress` and `session_progress` in the same transaction
  as completion: a failure after the status write leaves neither.
- a skipped session with answers writes progress; one without does not.
- an answer on an unsaved sense writes nothing.
- the list sorts by level both ways with stable ties, filters by level, and pages through a
  level sort without repeating or skipping.
- a query-plan test at phase 18's volume that pins §2's covering index: every list query shape
  uses it, and the first page stays within the 50 ms budget.
- the migration gives every existing entry five level 1 rows.
- the read route returns a completed session's `progress` block.
- the recompute rebuilds the same rows from the log, and writes back exactly what the live path
  wrote.

### E2E

1. A learner saves four senses, completes a list session, and the results screen shows the four
   words with the correctly answered ones at נחשפה and highlighted.
2. The saved list shows the badges, sorts by level, and filters to one level.
3. A word's detail shows five dimensions, one live.

### Eval

None. No prompt is added.

## 8. Risks and what to watch

- **The badge over-claims.** Four spaced all-correct multiple-choice days is good but not
  conclusive evidence, and up-only keeps a slipped word's level. Once answers accumulate: if
  the first answer of the day on level 5 senses is correct less than about 85% of the time,
  the gaps are too short or multiple choice needs a recall-format gate.
- **A stall.** After level 3 on day two, nothing moves for a week. If results screens with no
  word moved up become the norm, add the "days until the next level" hint rather than shorten
  the gaps.
- **A dimension going live drops badges once.** A word at (5, 1, 1) becomes badge 2 the day
  typing ships. Accepted as a deliberate recalibration, to be announced in the app, once per
  dimension. It is the cost of an overall badge over a per-dimension one.
