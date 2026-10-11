# Phase 34 — Ambiguous questions: one card, one right reading

- **Status:** Designed on 2026-10-11. Victor scoped the phase in the one-pager, an audit of lane 0
  found nine ways a card is ambiguous, and the design went through them one at a time with a
  card from lane 0 before and after each fix. Every decision is in §1 with its reason, so each
  one can be overturned in review.
- **Date:** 2026-10-11
- **Source:** `drafts/2026-10-11-ambiguous-questions-one-pager.md` (scope) and
  `drafts/2026-10-11-ambiguous-questions-findings.md` (the audit: 463 questions, 78 ambiguous,
  categories A–I). Category letters below are the audit's.

## Goal

Some cards have more than one right answer, or do not say which one they want. Victor met it
with "What does `saw` mean?" (the tool, or the past of *see*) and with "Translate בואו נשלב
כוחות". The audit found 78 such cards out of 463 in lane 0: 10 answers marked wrong, 6 of
them defensibly right, and 4 right answers credited only as "alternative", which scores but
records no progress.

After this phase every card either pins the reading it wants (a context sentence, a marked
word, a part of speech) or accepts every right reading of what it shows. A right answer that
is not the saved word earns a second try at the saved word instead of a dead end.

**Done means** (the one-pager's "every ambiguity found in the audit has a fix", made checkable):

1. Each of the eight categories in scope (A–H) has an automated test built on a flagged card
   from the audit, which fails on `master` and passes after the phase. Victor's two examples
   (`saw` a7d6bdb4 / 71b0b407, בואו נשלב כוחות eb95d246) are among them.
2. `npm run eval` has new cases for the checker (D5), the accepted-answers list (D1), context
   sentences (D6) and rendering–form agreement (D2), and passes without lowering
   `TIER2_THRESHOLD`.
3. `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Scope

**In:** categories A, B, C, D, E, F, G, H, every card type they touch, and a backfill so
existing saved words get the stored data D1 and D2 add.

**Out:**
- **I**, a homophone in dictation (`ho` / `o` / `oh`). Italian-only, one card, nobody marked
  wrong; the one-pager excludes Italian-only ambiguities. (D is Italian-only too, but D1 fixes it
  at no cost, so it is in.)
- Changing how lenient the judge is. Phase 23's rule stands: hints on the card, never a looser
  judge. The lemma rule stays as it is (D2).
- A learner-facing "my answer was right too" button.
- New card types, and session scheduling.
- Two oddities the audit found that are not ambiguity: dictation `combine` stored `wrong`
  (ecc5a439) and צד accepted as `exact` for צעד (2f107644). Each gets its own look.

## 1. Decisions

### D1. One accepted-answers list per rendering, stored and reused (B, D)

Today a typed or spoken card's other right answers are asked of the model afresh for every
session, inside the distractor batch, and come back different each time: אז accepted `allora`
on 89b4bb33 and refused it on 703a58ca. 29 of 47 typed cards had none.

A rendering (one row of `dict_var_translations`: a form, a sense, a learner language) gets
`accepted_answers`: every target-language word that translates that Hebrew rendering in that
sense, inflected to agree with it. Every typed translation and say-the-translation card whose
prompt is that rendering reads the same list.

- **Not the typed cloze.** A typed cloze is judged against the form its sentence needs, and its
  lemma is wrong (phase 27 D4, `verdictFor` in `quiz.ts`). A list inflected to the rendering
  would let `answer` pass in a gap that needs `answered`. The typed cloze keeps the sentence
  task's own alternatives, and F's `improve` reaches D9's second try through them.
- **Written by its own call**, a new `accept` task, not as a side job of distractor generation.
  Its prompt asks for every right translation of the rendering in this sense, with placeholders
  written out (`lose one's temper` → `lose my temper`, `lose your temper`, … one entry each), and,
  for a verb form whose subject the rendering implies, the form with its subject pronoun too
  (יש לי → `ho`, `io ho`). That last line is all D needs.
- **Only the `accept` job writes the column.** The session's `typed` alternatives are generated
  afresh per session, and phase 23's Risks already say a wrong one lets a wrong word pass. A
  model error there costs one card; written into the dictionary it would be permanent, shared by
  every learner of the pair, and would forbid a legitimate wrong option everywhere through D3.
  So a card's accepted answers are the stored list plus that session's own `typed`
  alternatives, stored on the question (D12) and never written back.
- **When: lazily, when a session picks the rendering.** A rendering is written by more paths than
  the save: the render-lemma job the save enqueues (`vocabulary.ts`), a later lookup of another
  form, and the stale-form repair. Instead of a hook on each, the prepare-session job enqueues
  the `accept` job for every rendering it picks whose `accepted_at` is null, with a pg-boss
  singleton key per rendering so a burst never pays twice. That card falls back to the session's
  own `typed` alternatives, as today; the next session has the list. A save-all of twenty glosses
  therefore enqueues nothing at save time; the calls spread over the sessions that use them.
- **`accepted_at` is what "done" means**, not a non-empty list: a rendering whose job found
  nothing beyond the form is stamped and never paid for again. The backfill keys on it (D13).
- **Kept across the repair and the export.** The stale-form repair (`repo/dictionary.ts`, the
  delete and re-insert of a variant's renderings) carries `accepted_answers`, `answer_form` and
  `accepted_at` over for every (variant, sense) whose `translation` text is unchanged, and leaves
  them null for a new or rewritten rendering, which the next session re-enqueues. The dictionary
  export and restore (`db/dictExport.ts`) carry the three columns, so the hosting runbook's
  restore does not empty them.
- **At most ten.** The cap rises from five to ten, here and on `questions.alternatives`.

### D2. The card's answer agrees with its prompt (G)

The `accept` call also returns the form of the headword that agrees with the rendering in number
and person, stored as `answer_form` (null when it is the variant's own form). The rendering is
never rewritten: what the dictionary or the learner recorded stays as recorded.

`ora`'s rendering שעות ("hours", from the example "per ore") gets `answer_form = ore`. A card
built from it asks for `ore`, its tiles are built from `ore`, and a choice card shows `ore`
beside שעות. A card built from שעה still asks for `ora`.

The judge's lemma rule is unchanged, so on the שעות card `ora` is also accepted. On the שעה
card, `ore` is wrong.

### D3. A wrong option never matches what is known to be right (A)

`badChoice` today compares a wrong option only with this session's rows. It also refuses an
option equal, under `comparable`, to:

1. any rendering, gloss key or gloss alternative of **any sense of the headword** in the
   learner language (*pick up* → להרים, c49ddbec);
2. any rendering of a **homograph**: another lexeme in the same language with a variant of the
   same written form (`saw` → ראה);
3. any `accepted_answers` entry of a rendering with the **same Hebrew text** in the same
   language pair (תכף → `presto`, 0fa3fc06).

A board's fifth meaning passes the same test, and `boardPicks` refuses two words whose
meanings overlap under it (`main` and `mainstream` both reach מרכזי).

### D4. Spare wrong options (A)

A choice item asks the model for six wrong options instead of three and keeps the first three
that pass D3 and D5. The batch fails, and pg-boss retries it, only when fewer than three pass.
Without spares, a stricter filter would only mean more failed batches.

### D4a. The batch's response schema is measured before anything is built on it

The batch travels as a Gemini `responseSchema`, and the repo has measured (comment above
`entries` in `packages/core/src/api/schemas.ts`) that array caps multiply the schema's states:
past a limit Gemini refuses the schema with a 400, every call fails, and MockServer, which never
validates a schema, cannot show it. D4 doubles the wrong options and D6 and D8 add a sentence and
spans per item, on a ten-item array. That failure would be every list session after the deploy.

So the build's first step, before the migration, is to send the new batch schema to the live API
for a full-size batch, as phase 31 did. If it is refused:

1. the context sentence (D6) and the sentence spans (D8) move out of the batch into their own
   call, which also takes the work off the batch's single answer;
2. if the batch is still refused, the spares (D4) come down to five, then four, measured each
   time.

The outcome and the numbers go in a comment beside the schema, in the style of the existing one.

### D5. A checker call after generation (A, C, E, F)

17 of A's 27 cards are synonyms the dictionary does not hold (*blow up* → להרוס). Only a model
can catch those. After the batch's answer is validated, one more call — a separate prompt, not
the generator checking itself — asks per item:

- **choice items:** for each wrong option, "could this be a correct translation of the word in
  any common use?" A yes drops the option, and a spare takes its place (D4);
- **gap items (cloze choice):** for each wrong option, "does the sentence still read correctly
  with this word in the gap?" A translation question would be the wrong test there: the
  sentence, not the word's meaning, is what makes an option right;
- **context sentences (D6):** "what does the marked word mean here?" (target-language sentence)
  or "which words in the target language fit the marked word?" (Hebrew sentence). An answer
  outside the sense's meanings, or outside its accepted answers, drops the sentence;
- **sentence cards (D8):** "translate this Hebrew sentence naturally". A translation that uses
  neither the practised word nor one of its accepted answers drops the sentence: בואו נשלב
  כוחות comes back "join forces", and is dropped.

An unreadable checker answer fails the batch like an unreadable generation does.

### D6. A context sentence on cards that show a bare word (C, E, H)

| Card | Sentence in | Marks | Audit |
|---|---|---|---|
| typed translation, say the translation, reverse choice | Hebrew | the prompt's word | C |
| typed meaning, multiple choice | the target language | the card's form | E, H |

- **Generated per question**, in the session's batch, not copied from the saved example, so it
  can be checked (D5) and varies between sessions. Victor's call: a fixed sentence can be
  memorised and cannot be fixed.
- **Multiple choice keeps it, and keeps its credit.** The sentence adds some reading to the card,
  and the card still credits written recognition as today. Victor's call: the sentence is short
  and in the language being learned, so reading it is the same skill, and it is the only hint that
  separates `saw` the tool from the past of *see*. Showing it only on words with several senses
  or a homograph would miss every reading the dictionary does not hold.
- **Generated in pairs.** The model writes both halves: the sentence the card shows and its
  translation, which is never shown and goes to the judge (D7).
- **Rules:** a Hebrew sentence never contains the target-language answer. The sentence differs
  from the last one shown for this gloss on this card type (phase 27 D8's rule). Breaking either
  drops the sentence.
- **The mark is best effort.** The model returns the marked word as text, and the service finds
  it in the sentence. Hebrew verbs inflect and take prefixes, so a word it cannot find is common,
  not an error: the sentence is kept and shown unmarked. It still pins the sense, which is what
  C needs.
- **Fallback:** a sentence dropped by a rule or by D5 is replaced by the matching half of the
  saved example, unmarked. A saved sense without an example (both halves are nullable) leaves the
  card as it is today, with the part of speech and no sentence, and the batch logs it.
- **Not on:** letter tiles (the letters pin the word), listen choice (a written sentence would
  show the word it is testing; D10 covers it), matching (D10), dictation and read aloud (the
  word is the whole point), and the sentence types (D8).

### D7. The judge sees what the learner saw

`findJudgeContext` today gives the meaning judge the saved example and its translation
(`judge.ts`, `example` and `example_translation`), which the learner never saw. It gets the
card's own sentence pair instead (D6): the target-language sentence shown, and the hidden Hebrew
translation that pins the sense, so the judge loses nothing it has today. When the card fell back
to the saved example, it gets the saved example, as today. Its rules do not change. The eval adds
meaning-judge cases built on a generated pair.

### D8. A sentence card names its word (F)

The batch's `sentence` and `translate` tasks also return the span of the practised word in the
Hebrew sentence (`sentence_translation`). The card marks it: **נשלב** in a translation card,
**ישתפרו** under a typed cloze. D5's natural-translation check keeps only sentences where the
practised word is the natural choice. A sentence that fails takes phase 27's existing degraded
path and becomes a typed translation card.

Leaving the word out stays wrong (phase 23). With the word marked, that is now fair.

### D9. A second try after a right answer that is not the saved word (B, E, F)

When the first verdict is `alternative` — another accepted word, another sense (`other_sense`),
or another word in a sentence (`other_word`) — the card stays open:

- `✓ נכון, <answer> מתאים כאן.` ("Right, <answer> fits here.") followed by
  **"יש מילה נוספת ששמרת — נסו שוב"** ("There's another word you saved — try again") on typed
  translation, say the translation, typed cloze and sentence translation, or **"יש פירוש נוסף —
  נסו שוב"** ("There's another meaning — try again") on typed meaning;
- the input is cleared; on sentence translation it holds the first sentence so the learner only
  changes the word; on say the translation the microphone is offered again, and the typed
  fallback works as on the first answer;
- **הצגת התשובה** ("show the answer") shows the saved word, as today's banner does, and resolves
  the retry as given up.

One retry, never more. The session score counts the first answer, which was right. Progress
counts the retry: an `exact`, `near_miss` or `understood` retry moves the gloss's dimensions as
that verdict would. A retry that gives up, or is wrong, leaves the answer where it is today:
right, no progress. The first answer is never re-judged, so the judge is no more lenient.

**How it fits the session's state machine.** Today recording an answer is what advances the
session (`step` in `packages/core`: the next position is the number of answers), and the last
answer completes the session and writes its progress in the same transaction
(`submitAnswer` in `services/sessions.ts`). A retry after that point would land on the replay
path, and on the last card progress would already be written. So an `alternative` answer that
offers a retry is recorded as **pending**, and a pending answer holds the session where it is:

- **Recording.** The answer row is written with its verdict and `retry_state = 'pending'`. `step`
  does not advance past a pending answer, and the session does not complete on one: completion,
  `completeSession` and `recordProgress` run when the last card's retry resolves.
- **Resolving.** The client sends the retry to the same route as the first answer, with
  `retry: true` and the same question id. It is accepted only at a pending position. It is judged
  by the same rule or model call the first answer was, stored in `retry_text` and
  `retry_verdict`, and `retry_state` becomes `resolved`. "Show the answer" sends `retry: true`
  with a give-up, recorded as `gave_up`.
- **All three routes.** Typed (`submitAnswer`), judged by a model (`answerJudged`: typed meaning,
  sentence translation) and spoken (`answerBySpeech`: say the translation). On the spoken route a
  clip with `retry: true` at a pending position is a retry. Without it, a clip there replays the
  pending first answer, as a network retry of the first clip must.
- **Replays.** A request without `retry` at a pending or resolved position replays the first
  answer's result, pending flag included, so a network retry of the first answer re-opens the
  second try. A request with `retry` at a resolved position replays the retry's result. Neither
  calls a model again.
- **Spending.** The judged and spoken routes call a model at most twice per card: once for the
  first answer and once for its one retry. The bound per card moves from one to two, and stays
  a bound.
- **Leaving and skipping.** A session left on a pending card resumes on its second try: loading a
  session returns the pending state. Skipping a session resolves a pending retry as given up
  before `recordProgress` runs, so the skip writes progress exactly as today.

For progress, an answer's evidence is its retry verdict when the retry resolved as `exact`,
`near_miss` or `understood`, and its first verdict otherwise (`findSessionEvidence`). For the
score, it is always the first verdict.

### D10. Part of speech on listen choice and matching (H)

Multiple choice gets its context sentence (D6). Listen choice gets the part-of-speech line the
reverse card already has; its sentence would spell out the word being heard. Matching shows
each word's part of speech under it. Four sentences would crowd the board, and D3 already
keeps another reading out of its meanings.

### D11. The judge's rules do not change

`judgeTyped`, `judgeSpoken`, the meaning and translation judges and their verdicts are
untouched. They read fuller lists (D1), the sentence the card showed (D7), and a second answer
(D9). Phase 23's "add hints, don't loosen grading" holds throughout.

### D12. Questions record what was shown

As phase 23 stores the prompt rather than joining it, a question stores its context sentence
(both halves) and marked spans, its answer form, and its accepted answers at the time it was
generated: the stored list plus that session's own `typed` alternatives (D1). A later backfill
or a changed list alters future cards, never an asked one.

### D13. Backfill

`npm run dict:accept` (through the lane wrapper, like every `dict:` script) enqueues D1's job
for every rendering, in its learner language, of a saved gloss's members whose `accepted_at` is
null. It saves the first session after the deploy from falling back on every card; D1's lazy
enqueue would get there anyway. Lane 0 has about 495 senses. Prod
needs the same run after the deploy, which goes under **Left for Victor** in the PR.

## 2. Changes

Names below are a starting point. Where the build departs, "As built" will say so.

### Data (one migration)

- `dict_var_translations`: `accepted_answers text[] not null default '{}'` (at most ten),
  `answer_form text` (null = the variant's form), `accepted_at timestamptz` (when D1's job last
  ran; null = never). The stale-form repair and the dictionary export carry all three (D1).
- `questions`:
  - `context text`, `context_translation text` (the hidden half, D7), `context_mark_start int`,
    `context_mark_end int` (D6);
  - `sentence_mark_start int`, `sentence_mark_end int` into `sentence_translation` (D8);
  - `answer_form text` (D2);
  - `alternatives`' check raised from five to ten.
  - The shape check names which types may carry a context.
- `answers`: `retry_state text` (null, `pending` or `resolved`), `retry_text text`,
  `retry_verdict text` (D9). Checks: a retry state only on an `alternative` verdict; text and
  verdict exactly when resolved; the same verdict list and length limit as the first answer.

### `packages/core`

- Question wire schemas: `context: { text, mark: { start, end } | null } | null` on the five D6
  types; `mark` on the sentence types; `part_of_speech` on listen choice and on each matching
  word (D10).
- The three answer requests (typed, judged, spoken) take `retry: true`. Their responses, and
  the session load, say when a retry is pending and which wording it uses (D9).
- `step`: a pending answer holds the position and blocks completion; a retry resolves it; the
  replay rules of D9.
- `typed.ts` / `spoken.ts`: unchanged (D11).

### Server

- `domain/accept.ts`: the `accept` prompt, its parser and its validation (target-language
  script, never the explanation language, no placeholder words, at most ten, `answer_form` a
  plausible form of the lemma).
- `domain/distractors.ts`:
  - D3's wider `badChoice`, fed a per-batch "known right" set the service reads once;
  - six wrong options and keep three (D4);
  - the context task (D6) and the sentence spans (D8) in `buildDistractorPrompt`.
- `domain/check.ts`: D5's checker prompt and parser.
- `services/sessions.ts`:
  - `prepareSession` reads the known-right set and the accepted answers, enqueues the `accept`
    job for picked renderings with a null `accepted_at` (D1), runs the checker, applies the
    fallbacks and stores the new columns;
  - `submitAnswer`, `answerJudged` and `answerBySpeech` record a pending answer and its retry,
    and complete the session only when nothing is pending (D9); `skipSession` resolves a
    pending retry first;
  - `findSessionEvidence` (repo) reads the retry verdict for progress.
- `repo/dictionary.ts`: the stale-form repair carries D1's columns over for unchanged renderings.
- `db/dictExport.ts`: export and restore carry D1's columns.
- A worker for the `accept` job (singleton key per rendering), and the `dict:accept` CLI (D13).
- `repo/questions.ts`: `findJudgeContext` reads the card's context (D7).

### Mobile

- A context line component: the sentence with its span marked, RTL or LTR by language, on the
  five D6 card views.
- The marked word on `translatePrompt` and `gapPrompt` (D8).
- The part-of-speech line on the listen choice card (which `MultipleChoiceView` renders) and under
  each word in `MatchingBoardView` (D10).
- The second-try state in the typed, spoken and sentence views, with the two strings from D9 in
  `strings.ts`.

### MockServer and eval

- MockServer expectations for the `accept` and checker calls, and the batch's new fields, so
  integration and e2e stay off the network.
- Eval cases:
  - **checker:** *blow up*/להרוס and *pick up*/להרים → yes; *blow up*/לקפל → no; בואו נשלב
    כוחות → not *combine*;
  - **accept:** `frate` for אח (במסדר דתי); `allora` for אז; `io ho` for יש לי; no `one's`;
    `answer_form = ore` for שעות;
  - **context:** a sentence for `saw`/לנסר whose checked meaning is לנסר, not ראה.

## 3. Testing

- **Unit:** D3 with the audit's verified cards as fixtures (c49ddbec, 0fa3fc06, the `saw`
  homograph, board 1d268882); D4's keep-three and fail-under-three; D5's parser and how a "yes"
  replaces an option; D6's rules and fallback; D9's scoring and progress rule; the app's
  feedback for a retry.
- **Integration (real Postgres):**
  - D1: preparing a session enqueues the `accept` job once per rendering with a null
    `accepted_at`, and not for a stamped one, even with an empty list; the job stores the list,
    the answer form and the stamp; a session's `typed` alternatives never reach the dictionary;
    the stale-form repair keeps the columns on an unchanged rendering and clears them on a
    rewritten one; export then restore round-trips them; the backfill enqueues only null stamps.
  - A session for the audit's cards stores context, spans and answer form.
  - D9, on each of the three routes: a pending answer holds the position; a network retry of the
    first answer replays it with the pending flag; the retry resolves it and moves progress; a
    give-up does not; on the last card the session completes, and progress is written, only
    when the retry resolves; a skip with a pending retry writes progress as today; a retry of the
    retry replays without a model call.
  - The new checks refuse bad rows.
- **E2E:** a typed card shows its context line; an alternative answer gets the second try and
  the saved word then counts; a sentence card shows its marked word.
- **Done-means 1:** one test per category A–H, named for the category and the audit card it
  rebuilds.
- **Architecture:** `npm run lint:arch`. No new ADR: the job follows ADR 0007, the data follows
  ADR 0011, and the wire follows ADR 0003.

## Build order

0. D4a: measure the batch's new response schema against the live API, and settle whether the
   context sentence and spans need their own call. Everything after builds on the answer.
1. Migration and D1/D2: the `accept` task, job, lazy enqueue, repair and export carry-over,
   backfill. A, B, D and G read from it.
2. D3 and D4 in `badChoice`, then D5's checker.
3. D6 and D7 (context sentences), D8 (sentence spans), D10 (part of speech): server, wire, app.
4. D9's second try: wire, recording, progress, app.
5. Eval cases, MockServer, e2e.

One PR, as every line of work here.

## Risks

- **Slower session preparation.** D5 adds a model call before a session is ready, and D4 and D6
  lengthen the batch's answer. The phase logs each batch's generation and
  checker time, as phase 27's `answer_judged` logs judging time, and the checker takes every
  item in one call.
- **An over-strict checker** drops too many options and sentences, and batches fail. D4's spares
  and D6's fallback absorb most of it; the eval's "no" cases guard against a checker that says
  yes to everything.
- **Gemini refusing the batch's schema** (D4a): every list session would fail with a 400 that
  MockServer cannot reproduce. Measured first, in build step 0.
- **Hebrew span marking** can miss the inflected word. A mark that cannot be found leaves the
  sentence unmarked (D6), not dropped.
- **Model spend.** The backfill is one call per saved rendering, once. After it, the `accept`
  job runs lazily, one rendering at a time as sessions pick them, with a singleton key, so a
  save-all of twenty glosses costs nothing at save time. The judged and spoken routes' bound
  moves from one model call per card to two (D9).

## As built

Built on branch `phase-34-ambiguous-questions`. Where the build departs from the letter of the
sections above, it is listed here with its reason; everything else was built as written.

**D4a, measured**

1. **The batch keeps six wrong options, and the context sentence and the sentence marks moved to
   a call of their own (D4a's first fallback).** Gemini accepted the full schema, but with the
   four new optional strings in it the batch's non-streaming call hung past 30 s (`translate it`
   8 of 8, `sentence en` 2 of 5); with six options and none of the strings it never hung (0 of
   14), and a context-only call answers in 2 to 7 s. The numbers are beside each schema in
   `packages/core/src/api/schemas.ts`. So `domain/context.ts` holds the context task and
   `domain/marks.ts` finds the marked word, where §2 put both in `buildDistractorPrompt`.
2. **The context call runs after the batch, and its failure degrades the session, never fails
   it.** A sentence card's mark needs the batch's Hebrew sentence. A failed, unreadable or empty
   answer logs `context_call_failed`, every card falls back as D6 says (the saved example,
   unmarked, or nothing), and sentence cards are unmarked: a missing hint is today's card, a
   failed session is worse. The checker keeps D5's rule: an unreadable answer fails the attempt.
3. **Each model call of a preparation has its own client and budget.** The batch keeps 300 s;
   the context call and the checker get 60 s each (`CONTEXT_CALL_BUDGET_MS`,
   `CHECKER_CALL_BUDGET_MS`), and the prepare job expires at twice their sum, 840 s, so a healthy
   attempt is never cut off and an optional hint cannot stall a session for five minutes.

**Ruled during the build**

- **`answer_form` is checked where a card reads it, not when the `accept` job stores it (§2's
  "a plausible form of the lemma").** A card asks for the stored form only when, a leading
  article or "to" left off, one of its words shares a prefix of `min(3, shorter word − 1)`
  letters, never fewer than two, with the lemma or the saved form (`ore`/`ora`,
  `libri`/`libro`); otherwise the card asks for the saved form, as before the phase. The job
  stores any form in the target script that is not the saved form. The cost: a suppletive form
  (`ho` for `avere`) falls back to the saved form, which the lemma rule still accepts.
- **The answer form is asked on multiple choice, listen choice (which also speaks it), reverse
  choice, typed translation, say the translation and letter tiles.** Matching, typed meaning,
  read aloud and dictation keep the saved form, so a plural rendering (שעות) still pairs with
  `ora` on a board and a meaning card; that is left for a follow-up.
- **A typed or spoken card accepts, in order: the stored list, up to three sibling headwords,
  the session's own alternatives, then the remaining siblings, ten in all.** Phase 31 D18's
  siblings are certain, and the stored list is never displaced by them.
- **D3's "known right" set is wider than §1 lists.** A rendering with the same Hebrew text
  contributes its form and lemma as well as its accepted answers (another headword rendering the
  same Hebrew is right on the reversed card), and each picked gloss contributes its own key,
  alternatives and member renderings, which the checker's context rule reads as "the sense's
  meanings". `boardPicks` refuses two words when either one's board meaning is a known meaning
  of the other.
- **The checker also judges the board, and reads only the sentences the context call wrote.**
  It is asked about the fifth-meaning candidates against each of the four board words, since one
  right for the third word is as wrong as one right for the first. A saved example the card fell
  back on is the learner's own, and is not checked. A Hebrew context is checked by a list
  (`context_words`, a field §2 does not name), judged with the card's own `judgeTyped`.
- **A target-language context must contain the form the card shows, or it is dropped; a
  sentence without its other half is dropped too.** The mark of a target sentence is that form,
  and the judge needs the hidden half (D7).
- **The board carries `parts_of_speech`, parallel to its `words`,** where §2 says `part_of_speech`
  on each matching word: the board is built from parallel arrays.
- **The second try's wire (D9).** Giving up is each route's existing "show the answer" input with
  `retry: true`: an empty text on the typed and judged routes, `pass: 'show_answer'` through
  next-step for say the translation. A held card comes back as the same `question` with a
  top-level `pending_retry: { answer, wording: 'word' | 'meaning' } | null` on the not-complete
  next-step response (and so inside the judged and spoken responses' `next`), and on the session
  view, which a resumed session reads. A retry sent as a skip is a give-up too, since D9 ends a second
  try with an answer or a give-up.
- **A given-up retry on the judged route is reported to the app as `wrong` and stored as
  `gave_up`.** The response's verdict enum was not widened: the app builds its typed verdict from
  it and shows the saved word either way.
- **After a give-up or a wrong second try the app shows today's green banner for an
  `alternative` answer on that card** ("נכון! המילה שתרגלנו:", or "נכון, אבל כאן תרגלנו:" on
  typed meaning), where D9 says "as today's banner does". The first answer was right and the
  score counts it right, so a red "wrong" banner would contradict both.
- **An answer the phone judges `alternative` waits for the server** on typed translation, the
  typed cloze and say the translation's typed form: the server holds the card, and the banner
  would otherwise name the saved word before the second try. A failed call shows the judged
  card's "try again", where a phone-judged card used to alert and go home.
- **`API_LEVEL` is 2 (ADR 0012).** After an `alternative` the next-step response is the same card
  again; a level-1 app would show it as a new card, answer it without `retry`, get the pending
  answer replayed, and be stuck there. Level-1 builds see "update required" once the server is
  live.
- **On the spoken route an unheard retry records nothing and stays open,** as an unheard first
  clip always has, so "at most twice per card" bounds the recorded answers; an unheard clip
  costs a transcription call, as before the phase.
- **The `accept` queue has pg-boss's `exclusive` policy.** A singleton key holds only on such a
  queue; on a standard one pg-boss ignores it.
- **The eval's context case is scored on structure, and the checker case reads the sentence.**
  The `context` line checks that the `saw`/לנסר sentence shows `saw` and that its Hebrew holds a
  form of נסר and none of ראה; the `checker` line checks that the checker reads it as לנסר.
- **The e2e suite answers the three new calls by default.** `clearGemini` registers again, after
  every clear, an `accept` answer that stamps the rendering (so no job retries in the background
  and takes a later spec's one-shot stub), a context answer with no sentence, and a checker that
  keeps every stubbed card; a spec ranks its own answer above them.
