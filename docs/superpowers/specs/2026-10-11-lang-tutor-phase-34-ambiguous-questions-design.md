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
sense, inflected to agree with it. Every typed, spoken and typed-cloze card whose prompt is
that rendering reads the same list.

- **Written by its own call**, a new `accept` task, not as a side job of distractor generation.
  Its prompt asks for every right translation of the rendering in this sense, with placeholders
  written out (`lose one's temper` → `lose my temper`, `lose your temper`, … one entry each), and,
  for a verb form whose subject the rendering implies, the form with its subject pronoun too
  (יש לי → `ho`, `io ho`). That last line is all D needs.
- **When:** a job enqueued in the transaction that saves a gloss, one per member rendering in
  the learner language (ADR 0007). A backfill command enqueues it for every saved gloss (D13).
- **Grow-only, at most ten.** A later answer from the session's `typed` task is merged in, never
  replacing. The cap rises from five to ten, here and on `questions.alternatives`.
- **Until the job has run**, a card uses the session's own `typed` alternatives, as today.

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

### D5. A checker call after generation (A, C, E, F)

17 of A's 27 cards are synonyms the dictionary does not hold (*blow up* → להרוס). Only a model
can catch those. After the batch's answer is validated, one more call — a separate prompt, not
the generator checking itself — asks per item:

- **choice items:** for each wrong option, "could this be a correct translation of the word in
  any common use?" A yes drops the option, and a spare takes its place (D4);
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
- **Rules:** the marked span is in the sentence. A Hebrew sentence never contains the
  target-language answer. The sentence differs from the last one shown for this gloss on this
  card type (phase 27 D8's rule).
- **Fallback:** a sentence that fails a rule or D5 is replaced by the matching half of the saved
  example, unmarked. A card never goes without one.
- **Not on:** letter tiles (the letters pin the word), listen choice (a written sentence would
  show the word it is testing; D10 covers it), matching (D10), dictation and read aloud (the
  word is the whole point), and the sentence types (D8).

### D7. The judge sees what the learner saw

`findJudgeContext` today gives the meaning judge the saved example, which the learner never
saw. It gets the card's own context sentence instead. Its rules do not change.

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
- the input is cleared, except on sentence translation, where it holds the first sentence so the
  learner only changes the word;
- **הצגת התשובה** ("show the answer") shows the saved word, as today's banner does.

One retry, never more. The session score counts the first answer, which was right. Progress
counts the retry: an `exact`, `near_miss` or `understood` retry moves the gloss's dimensions as
that verdict would. A retry that gives up, or is wrong, leaves the answer where it is today:
right, no progress. The first answer is never re-judged, so the judge is no more lenient.

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
and marked spans, its answer form, and its accepted answers at the time it was generated. A
later backfill or a grown list changes future cards, never an asked one.

### D13. Backfill

`npm run dict:accept` (through the lane wrapper, like every `dict:` script) enqueues D1's job
for every saved gloss that has no `accepted_answers` yet. Lane 0 has about 495 senses. Prod
needs the same run after the deploy, which goes under **Left for Victor** in the PR.

## 2. Changes

Names below are a starting point. Where the build departs, "As built" will say so.

### Data (one migration)

- `dict_var_translations`: `accepted_answers text[] not null default '{}'` (at most ten),
  `answer_form text` (null = the variant's form), `accepted_at timestamptz` (when D1's job last
  ran; null = never).
- `questions`:
  - `context text`, `context_mark_start int`, `context_mark_end int` (D6);
  - `sentence_mark_start int`, `sentence_mark_end int` into `sentence_translation` (D8);
  - `answer_form text` (D2);
  - `alternatives`' check raised from five to ten.
  - The shape check names which types may carry a context.
- `answers`: `retry_text text`, `retry_verdict text` (D9), with a check that a retry exists only
  after an `alternative` verdict, and the same verdict list and length limit as the first
  answer.

### `packages/core`

- Question wire schemas: `context: { text, mark: { start, end } | null } | null` on the five D6
  types; `mark` on the sentence types; `part_of_speech` on listen choice and on each matching
  word (D10).
- An answer request may say it is the retry; the answer response says when a retry is offered
  and which wording it uses.
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
- `services/sessions.ts`: reads the known-right set and the accepted answers, runs the checker,
  applies the fallbacks, stores the new columns, and records and scores the retry (D9).
- `services/vocabulary.ts` (save): enqueues D1's job in the save transaction (ADR 0007).
- A worker for the `accept` job, and the `dict:accept` CLI (D13).
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
- **Integration (real Postgres):** saving a gloss enqueues D1's job; the job stores
  `accepted_answers` and `answer_form` and only grows them; the backfill enqueues only what is
  missing; a session for the audit's cards stores context, spans and answer form; a retry is
  recorded and moves progress; the new checks refuse bad rows.
- **E2E:** a typed card shows its context line; an alternative answer gets the second try and
  the saved word then counts; a sentence card shows its marked word.
- **Done-means 1:** one test per category A–H, named for the category and the audit card it
  rebuilds.
- **Architecture:** `npm run lint:arch`. No new ADR: the job follows ADR 0007, the data follows
  ADR 0011, and the wire follows ADR 0003.

## Build order

1. Migration and D1/D2: the `accept` task, job, save hook, backfill. A, B, D and G read from it.
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
- **Hebrew span marking** can miss the inflected word. A span that does not fall on the sentence
  leaves it unmarked, not wrong.
- **The backfill's cost** is one call per saved rendering, once.
